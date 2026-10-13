// PCS Neighborhood Match agent.
//
// Plan-and-execute loop:
//   1. understand  - LLM turns the family's free text into typed favorites and interests
//   2. ground      - tools resolve every favorite and interest to Qloo entity and tag IDs
//   3. plan        - LLM checks the resolutions, drops wrong matches, picks tags and scope
//   4. execute     - tools query Qloo; empty results trigger an automatic broaden-and-retry
//   5. brief       - LLM writes the welcome kit from tool results only; a validator
//                    removes anything that did not come from Qloo
// Every LLM step has a deterministic fallback, so the kit still works when the
// free model allocation is used up.

import { resolveDestination } from "./stations.js";
import { makeTools, nameArea, typeForKind } from "./tools.js";

const MAX_FIELD = 400;

export function sanitizeInput(raw = {}) {
  const s = (v) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").slice(0, MAX_FIELD).trim();
  const budget = Number.parseInt(raw.budget, 10);
  return {
    stationId: s(raw.stationId),
    otherCity: s(raw.otherCity),
    homeCity: s(raw.homeCity),
    places: s(raw.places),
    music: s(raw.music),
    screen: s(raw.screen),
    reading: s(raw.reading),
    activities: s(raw.activities),
    kids: ["none", "young", "teens", "both"].includes(raw.kids) ? raw.kids : "none",
    budget: budget >= 1 && budget <= 4 ? budget : 3,
  };
}

const splitList = (text) =>
  String(text || "")
    .split(/[,;\n]| and /i)
    .map((x) => x.trim())
    .filter((x) => x.length > 1)
    .slice(0, 6);

// Deterministic reading of the form: each field already says what kind of thing it holds.
export function heuristicProfile(input) {
  const favorites = [
    ...splitList(input.places).map((name) => ({ name, kind: "place" })),
    ...splitList(input.music).map((name) => ({ name, kind: "artist" })),
    ...splitList(input.screen).map((name) => ({ name, kind: "tv_show" })),
    ...splitList(input.reading).map((name) => ({ name, kind: "book" })),
  ].slice(0, 12);
  const interests = splitList(input.activities);
  return { favorites, interests, kids: input.kids !== "none" };
}

const UNDERSTAND_SYSTEM = `You help military families who are moving to a new duty station (a PCS move).
Read what the family loves and return JSON only, with this shape:
{"favorites":[{"name":string,"kind":"place"|"artist"|"movie"|"tv_show"|"book"|"podcast"|"brand"|"video_game"}],
 "interests":[string],
 "kids":boolean}
Rules: copy names exactly as written; "place" is a restaurant, cafe, bar, shop or venue;
use "movie" or "tv_show" correctly; interests are short activity phrases such as "hiking", "craft beer",
"live music", "farmers market"; at most 12 favorites and 6 interests. Return the JSON object and nothing else.`;

async function understand(llm, input) {
  const user = JSON.stringify({
    places_back_home: input.places,
    music: input.music,
    shows_and_movies: input.screen,
    books_and_podcasts: input.reading,
    things_we_like_to_do: input.activities,
    kids: input.kids,
  });
  const out = await llm.json(UNDERSTAND_SYSTEM, user, { maxTokens: 600 });
  const favorites = (out.favorites || [])
    .filter((f) => f && f.name && typeForKind(f.kind))
    .map((f) => ({ name: String(f.name).slice(0, 80), kind: f.kind }))
    .slice(0, 12);
  const interests = (out.interests || []).map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 6);
  if (!favorites.length && !interests.length) throw new Error("empty understanding");
  return { favorites, interests, kids: Boolean(out.kids) || input.kids !== "none" };
}

const PLAN_SYSTEM = `You are the planning step of an agent that builds a welcome kit for a military family moving to a new base.
You get the family's favorites as resolved by the Qloo taste graph, and candidate Qloo tags.
Search can return the wrong thing (for example a song instead of the band). Return JSON only:
{"keep_entity_ids":[string],      // resolved ids that really match what the family meant
 "area_tag_ids":[string],         // 0-3 tags that matter for choosing where to live
 "food_tag_ids":[string],         // 0-2 tags for first-week restaurants and cafes
 "activity_tag_ids":[string],     // 0-2 tags for things to do
 "weekend_radius_km":number,      // 150-400, how far they would drive for a weekend trip
 "common_ground":["artist"|"tv_show"|"podcast"|"movie"],  // 1-2 kinds of local favorites to show
 "reasoning":string}              // one sentence
Only use ids that appear in the input. Return the JSON object and nothing else.`;

async function plan(llm, { favorites, tags, input, destination }) {
  const user = JSON.stringify({
    destination: destination.label,
    budget_level: input.budget,
    kids: input.kids,
    resolved_favorites: favorites.filter((f) => f.id).map((f) => ({ id: f.id, typed: f.input, matched: f.name, kind: f.kind, type: f.type })),
    candidate_tags: tags.map((t) => ({ id: t.id, name: t.name, from: t.query })),
  });
  const out = await llm.json(PLAN_SYSTEM, user, { maxTokens: 500 });
  const favIds = new Set(favorites.filter((f) => f.id).map((f) => f.id));
  const tagIds = new Set(tags.map((t) => t.id));
  const onlyKnown = (arr, known, n) => (Array.isArray(arr) ? arr.filter((x) => known.has(x)).slice(0, n) : []);
  const keep = onlyKnown(out.keep_entity_ids, favIds, 15);
  return {
    keepEntityIds: keep.length ? keep : [...favIds],
    areaTagIds: onlyKnown(out.area_tag_ids, tagIds, 3),
    foodTagIds: onlyKnown(out.food_tag_ids, tagIds, 2),
    activityTagIds: onlyKnown(out.activity_tag_ids, tagIds, 2),
    weekendRadiusKm: clamp(Number(out.weekend_radius_km) || 250, 150, 400),
    commonGround: (Array.isArray(out.common_ground) ? out.common_ground : ["artist"])
      .filter((k) => ["artist", "tv_show", "podcast", "movie"].includes(k))
      .slice(0, 2),
    reasoning: String(out.reasoning || "").slice(0, 300),
  };
}

function defaultPlan({ favorites, tags }) {
  const ids = favorites.filter((f) => f.id).map((f) => f.id);
  const t = tags.map((x) => x.id);
  return {
    keepEntityIds: ids,
    areaTagIds: t.slice(0, 2),
    foodTagIds: [],
    activityTagIds: t.slice(0, 2),
    weekendRadiusKm: 250,
    commonGround: ["artist", "tv_show"],
    reasoning: "Default plan: use every resolved favorite and the first matching interest tags.",
  };
}

const BRIEF_SYSTEM = `You write the welcome kit for a military family arriving at a new duty station.
Use ONLY the items in the input. Every "id" you output must be copied from the input.
Each "why" is one plain sentence that names the family favorite that drove the match when "because" is given.
No invented places, no prices, no hours, no claims about schools or safety.
Write short, plain sentences. Do not use dashes as punctuation, exclamation marks or sales language.
Return JSON only:
{"headline":string,
 "summary":string,                                  // 2 sentences
 "areas":[{"id":string,"why":string}],               // ids from areas
 "first_week":[{"id":string,"why":string}],          // up to 6, ids from first_week_candidates
 "kids":[{"id":string,"why":string}],                // ids from kids_candidates, may be empty
 "weekend":[{"id":string,"why":string}],             // up to 3, ids from weekend_candidates
 "common_ground":[{"id":string,"why":string}]}       // up to 4, ids from common_ground_candidates`;

function compactForBrief(facts) {
  const nameOf = new Map(facts.favorites.filter((f) => f.id).map((f) => [f.id, f.input]));
  const because = (e) => (e.explain || []).slice(0, 2).map((x) => nameOf.get(x.id)).filter(Boolean);
  const c = (e) => ({ id: e.id, name: e.name, address: e.address || undefined, because: because(e) });
  return {
    destination: facts.destination.label,
    family_favorites: facts.favorites.filter((f) => f.id).map((f) => f.input),
    areas: facts.areas.map((a) => ({ id: a.geohash, name: a.name, taste_match: a.affinity, sample_places: a.places.slice(0, 3).map((p) => p.name) })),
    first_week_candidates: facts.firstWeek.map(c),
    kids_candidates: facts.kidsPlaces.map(c),
    weekend_candidates: facts.weekend.map(c),
    common_ground_candidates: facts.commonGround.map(c),
  };
}

// Model text is shown to families. Replace dash punctuation with commas and drop
// exclamation marks so the kit reads like plain notes.
export function plain(text) {
  return String(text || "")
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .replace(/!+/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function validateKit(kit, facts) {
  const known = (list, key = "id") => new Map(list.map((x) => [x[key], x]));
  const areaMap = known(facts.areas, "geohash");
  const sections = {
    first_week: known(facts.firstWeek),
    kids: known(facts.kidsPlaces),
    weekend: known(facts.weekend),
    common_ground: known(facts.commonGround),
  };
  const clean = (arr, map, n) =>
    (Array.isArray(arr) ? arr : [])
      .filter((x) => x && map.has(x.id))
      .slice(0, n)
      .map((x) => ({ ...map.get(x.id), why: plain(x.why).slice(0, 280) }));
  const out = {
    headline: plain(kit.headline).slice(0, 120),
    summary: plain(kit.summary).slice(0, 500),
    areas: clean(kit.areas, areaMap, 4),
    first_week: clean(kit.first_week, sections.first_week, 6),
    kids: clean(kit.kids, sections.kids, 4),
    weekend: clean(kit.weekend, sections.weekend, 3),
    common_ground: clean(kit.common_ground, sections.common_ground, 4),
  };
  // Never let the model silently drop a whole section that Qloo filled.
  const template = templateKit(facts);
  for (const k of ["areas", "first_week", "kids", "weekend", "common_ground"]) {
    if (!out[k].length && template[k].length) out[k] = template[k];
  }
  if (!out.headline) out.headline = template.headline;
  if (!out.summary) out.summary = template.summary;
  return out;
}

export function templateKit(facts) {
  const nameOf = new Map(facts.favorites.filter((f) => f.id).map((f) => [f.id, f.input]));
  const why = (e, fallback) => {
    const src = (e.explain || []).map((x) => nameOf.get(x.id)).filter(Boolean);
    return src.length ? `Matched to your love of ${src.slice(0, 2).join(" and ")}.` : fallback;
  };
  const dest = facts.destination.label;
  return {
    headline: `Your taste map for ${dest}`,
    summary: `These picks come from the Qloo taste graph and are based on the favorites you entered. Start with the best-matching areas, then try a few places from the first-week list.`,
    areas: facts.areas.map((a) => ({
      ...a,
      why: `Strong taste match (${Math.round((a.affinity ?? 0) * 100)}%) for your favorites${a.places.length ? `, near spots like ${a.places.slice(0, 2).map((p) => p.name).join(" and ")}` : ""}.`,
    })),
    first_week: facts.firstWeek.slice(0, 6).map((e) => ({ ...e, why: why(e, "A close match to your family's taste in this area.") })),
    kids: facts.kidsPlaces.slice(0, 4).map((e) => ({ ...e, why: why(e, "Good for families and close to your taste.") })),
    weekend: facts.weekend.slice(0, 3).map((e) => ({ ...e, why: why(e, "A weekend trip that fits what you enjoy.") })),
    common_ground: facts.commonGround.slice(0, 4).map((e) => ({ ...e, why: why(e, "Popular here and close to your taste. Good for small talk with new neighbors.") })),
  };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

const KIND_TYPE = {
  artist: "urn:entity:artist",
  tv_show: "urn:entity:tv_show",
  podcast: "urn:entity:podcast",
  movie: "urn:entity:movie",
};

/**
 * Run the agent.
 * @param {object} rawInput form fields
 * @param {{qloo: import('./qloo.js').QlooClient, llm: any}} deps
 */
export async function runAgent(rawInput, { qloo, llm }) {
  const started = Date.now();
  const trace = [];
  const log = (step, detail) => trace.push({ step, detail, ms: Date.now() - started });
  const input = sanitizeInput(rawInput);
  const destination = resolveDestination(input);
  if (!destination) throw new UserError("Pick a duty station or type the city you're moving to.");
  const tools = makeTools(qloo);
  let llmSteps = 0;

  // 1. Understand
  let profile;
  if (llm) {
    try {
      profile = await understand(llm, input);
      llmSteps++;
      log("understand", `Model read ${profile.favorites.length} favorites and ${profile.interests.length} interests.`);
    } catch (err) {
      profile = heuristicProfile(input);
      log("understand", `Model unavailable (${short(err)}); read the form fields directly.`);
    }
  } else {
    profile = heuristicProfile(input);
    log("understand", "Read the form fields directly.");
  }
  if (!profile.favorites.length && !profile.interests.length) {
    throw new UserError("Tell us at least one place, artist, show or activity your family loves.");
  }

  // 2. Ground in Qloo
  const home = input.homeCity ? await tools.resolve_locality({ name: input.homeCity }).catch(() => null) : null;
  const interestQueries = [...profile.interests];
  if (profile.kids) interestQueries.push("family friendly");
  const [favorites, tags] = await Promise.all([
    tools.resolve_favorites({ items: profile.favorites, nearLocality: home }),
    tools.find_tags({ queries: interestQueries }),
  ]);
  const resolvedCount = favorites.filter((f) => f.id).length;
  const homeNote = home?.lat != null
    ? ` (place search centered on ${home.name} at ${Number(home.lat).toFixed(2)},${Number(home.lon).toFixed(2)})`
    : home
      ? ` (home locality ${home.name} had no coordinates)`
      : "";
  log("ground", `Qloo resolved ${resolvedCount} of ${favorites.length} favorites and ${tags.length} interest tags${homeNote}.`);
  if (!resolvedCount && !tags.length) {
    throw new UserError("Qloo couldn't match any of those favorites. Try full names, like a band name or a restaurant with its city.");
  }

  // 3. Plan
  let p;
  if (llm) {
    try {
      p = await plan(llm, { favorites, tags, input, destination });
      llmSteps++;
      const dropped = resolvedCount - p.keepEntityIds.length;
      log("plan", `${p.reasoning || "Plan ready."}${dropped > 0 ? ` Dropped ${dropped} wrong match${dropped > 1 ? "es" : ""}.` : ""}`);
    } catch (err) {
      p = defaultPlan({ favorites, tags });
      log("plan", `Model unavailable (${short(err)}); used the default plan.`);
    }
  } else {
    p = defaultPlan({ favorites, tags });
    log("plan", p.reasoning);
  }
  const kidTag = tags.find((t) => t.query === "family friendly")?.id;
  const ids = p.keepEntityIds;

  // 4. Execute, with broaden-and-retry on empty results
  const retry = async (label, attempts) => {
    for (const [i, fn] of attempts.entries()) {
      try {
        const res = await fn();
        if (res && res.length) {
          if (i > 0) log("retry", `${label}: first query came back empty, broadened and retried.`);
          return res;
        }
      } catch {
        /* try the broader query */
      }
    }
    log("retry", `${label}: no results after broadening.`);
    return [];
  };

  const loc = destination.locality;
  const [areasRaw, firstWeek, kidsPlaces, weekend, ...ground] = await Promise.all([
    retry("Where to live", [
      () => tools.taste_heatmap({ locality: loc, entityIds: ids, tagIds: p.areaTagIds }),
      () => tools.taste_heatmap({ locality: loc, entityIds: ids, tagIds: [] }),
    ]),
    retry("First week", [
      () => tools.places_in_area({ locality: loc, entityIds: ids, tagIds: [...p.foodTagIds, ...p.activityTagIds], priceMax: input.budget, take: 8 }),
      () => tools.places_in_area({ locality: loc, entityIds: ids, tagIds: [], take: 8 }),
    ]),
    profile.kids && kidTag
      ? retry("Kids", [() => tools.places_in_area({ locality: loc, entityIds: ids, tagIds: [kidTag], take: 6 })])
      : Promise.resolve([]),
    retry("Weekend trips", [
      () => tools.weekend_destinations({ locality: loc, entityIds: ids, radiusKm: p.weekendRadiusKm }),
      () => tools.weekend_destinations({ locality: loc, entityIds: ids, radiusKm: 600 }),
    ]),
    ...p.commonGround.map((k) =>
      retry(`Common ground (${k})`, [() => tools.local_common_ground({ locality: loc, entityIds: ids, type: KIND_TYPE[k], take: 4 })]),
    ),
  ]);

  const top = areasRaw.slice(0, 3);
  const areaPlaces = await Promise.all(
    top.map((a) => tools.places_in_area({ geohash: a.geohash, entityIds: ids, tagIds: [], take: 5 }).catch(() => [])),
  );
  const areas = top.map((a, i) => ({ ...a, name: nameArea(areaPlaces[i], `Area ${i + 1}`), places: areaPlaces[i] }));
  const commonGround = dedupe(ground.flat());
  log("execute", `Found ${areas.length} areas, ${firstWeek.length} first-week places, ${weekend.length} weekend trips and ${commonGround.length} local favorites. ${qloo.calls} Qloo calls so far.`);

  const facts = { destination, favorites, areas, firstWeek: dedupe(firstWeek), kidsPlaces: dedupe(kidsPlaces), weekend: dedupe(weekend), commonGround };

  // 5. Brief
  let kit;
  if (llm) {
    try {
      const draft = await llm.json(BRIEF_SYSTEM, JSON.stringify(compactForBrief(facts)), { maxTokens: 1100 });
      llmSteps++;
      kit = validateKit(draft, facts);
      log("brief", "Model wrote the kit; every item was checked against Qloo results.");
    } catch (err) {
      kit = templateKit(facts);
      log("brief", `Model unavailable (${short(err)}); wrote the kit from templates.`);
    }
  } else {
    kit = templateKit(facts);
    log("brief", "Wrote the kit from templates.");
  }

  return {
    destination,
    favorites: favorites.map(({ input: typed, kind, id, name }) => ({ typed, kind, id, matched: name || null })),
    kit,
    trace,
    stats: { qlooCalls: qloo.calls, llmSteps, ms: Date.now() - started },
  };
}

export class UserError extends Error {}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => e && e.id && !seen.has(e.id) && seen.add(e.id));
}

function short(err) {
  return String(err?.message || err).slice(0, 80);
}
