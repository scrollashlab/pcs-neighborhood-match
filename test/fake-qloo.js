// Synthetic stand-in for the Qloo API used by the tests. All names and IDs
// here are made up; no real Qloo response data is stored in this repository.

export function fakeFetch({ emptyFirstHeatmap = false, emptyFirstBudgetPlaces = false, log = [] } = {}) {
  let heatmapCalls = 0;
  let budgetPlaceCalls = 0;
  return async (url, init) => {
    const u = new URL(url);
    log.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init?.headers });
    const p = u.searchParams;
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    // Mirror the live API: an empty list parameter such as signal.interests.tags= is a 400.
    for (const [k, v] of u.searchParams) {
      if (v === "") return new Response(JSON.stringify({ error: { message: `${k} must not be empty` } }), { status: 400, headers: { "content-type": "application/json" } });
    }

    if (u.pathname === "/search") {
      const q = p.get("query");
      if (p.get("types") === "urn:entity:locality") {
        // First hit deliberately wrong-country; second is the real US city — mirrors live API.
        return ok({
          results: [
            {
              entity_id: "LOC-WRONG",
              name: `${q} (wrong country)`,
              subtype: "urn:entity:locality",
              location: { lat: 20.98, lon: -101.49 },
              properties: {
                place: "quarter",
                ancestors: [
                  { name: "Guanajuato", place: "state", abbreviation: "Gto.", admin_level: 4 },
                  { name: "México", place: "country", admin_level: 2 },
                ],
              },
            },
            {
              entity_id: "LOC-HOME",
              name: q.replace(/,.*/, "").trim() || q,
              subtype: "urn:entity:locality",
              location: { lat: 29.42, lon: -98.49 },
              properties: {
                place: "city",
                ancestors: [
                  { name: "Texas", place: "state", abbreviation: "Tex.", admin_level: 4 },
                  { name: "United States of America", place: "country", abbreviation: "USA", admin_level: 2 },
                ],
              },
            },
          ],
        });
      }
      if (q === "Nothing Matches") return ok({ results: [] });
      const loc = p.get("filter.location");
      const subtype = p.get("types") || "urn:entity:artist";
      const nearHome = loc && loc.startsWith("29.");
      const name = nearHome && subtype === "urn:entity:place"
        ? `${q} (San Antonio)`
        : `${q} (matched)`;
      return ok({
        results: [
          {
            entity_id: `ENT-${slug(q)}`,
            name,
            subtype,
            location: nearHome ? { lat: 29.55, lon: -98.5 } : { lat: 41.48, lon: -87.05 },
            properties: { address: "100 Main St", geocode: { city: nearHome ? "San Antonio" : "Valparaiso" } },
          },
          {
            entity_id: `ENT-${slug(q)}-ALT`,
            name: `${q} Alternate`,
            subtype,
            location: { lat: 33.37, lon: -112.31 },
            properties: { address: "200 Other St", geocode: { city: "Avondale" } },
          },
        ],
      });
    }
    if (u.pathname === "/v2/tags") {
      const q = p.get("filter.query");
      // Include a distractor tag so tagMatchScore has something to reject.
      return ok({
        results: {
          tags: [
            { id: `urn:tag:test:other`, name: "Dining", type: "urn:tag:test" },
            { id: `urn:tag:test:${slug(q)}`, name: q, type: "urn:tag:test" },
          ],
        },
      });
    }
    if (u.pathname === "/v2/insights") {
      const type = p.get("filter.type");
      const signal = (p.get("signal.interests.entities") || "").split(",").filter(Boolean);
      if (type === "urn:heatmap") {
        heatmapCalls++;
        if (emptyFirstHeatmap && heatmapCalls === 1) return ok({ success: true, results: { heatmap: [] } });
        return ok({
          success: true,
          results: {
            heatmap: [
              cell(35.05, -78.88, "dnrgaaaa", 0.95, 0.8),
              cell(35.06, -78.89, "dnrgaaab", 0.93, 0.7),
              cell(35.12, -79.01, "dnrgbbbb", 0.71, 0.9),
              cell(35.2, -78.7, "dnrgcccc", 0.4, 0.2),
            ],
          },
        });
      }
      const geohash = p.get("filter.location.geohash");
      if (type === "urn:entity:place" && p.get("filter.price_level.max")) {
        budgetPlaceCalls++;
        if (emptyFirstBudgetPlaces && budgetPlaceCalls === 1) return ok({ success: true, results: { entities: [] } });
      }
      const prefix = { "urn:entity:place": "PLACE", "urn:entity:destination": "DEST", "urn:entity:artist": "ART", "urn:entity:tv_show": "TV" }[type] || "X";
      const n = Number(p.get("take") || 3);
      const entities = Array.from({ length: Math.min(n, 4) }, (_, i) => ({
        entity_id: `${prefix}-${geohash || "city"}-${i}`,
        name: `${prefix} ${geohash ? geohash.slice(0, 5) : "city"} ${i + 1}`,
        subtype: type,
        properties: { address: `${100 + i} Main St`, geocode: { city: geohash === "dnrga" ? "Haymount" : "Fayetteville" }, price_level: 2 },
        location: { lat: 35.05, lon: -78.88, geohash: geohash ? `${geohash}xyz` : "dnrgzzzz" },
        query: { affinity: 0.9 - i * 0.1, explainability: { "signal.interests.entities": signal.slice(0, 1).map((id) => ({ entity_id: id, score: 0.7 })) } },
      }));
      return ok({ success: true, results: { entities } });
    }
    return new Response("{}", { status: 404 });
  };
}

function cell(lat, lon, geohash, affinity, popularity) {
  return { location: { latitude: lat, longitude: lon, geohash }, query: { affinity, affinity_rank: affinity, popularity } };
}

function slug(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "-");
}

// A stub model: returns canned JSON per step, optionally inventing an ID.
export function fakeLlm({ hallucinate = false, fail = false } = {}) {
  return {
    model: "stub",
    async json(system, user) {
      if (fail) throw new Error("allocation exhausted");
      const data = JSON.parse(user);
      if (system.includes("Read what the family loves")) {
        return {
          favorites: [
            { name: "Rudy's BBQ", kind: "place" },
            { name: "George Strait", kind: "artist" },
            { name: "Bluey", kind: "tv_show" },
          ],
          interests: ["hiking"],
          kids: true,
        };
      }
      if (system.includes("planning step")) {
        return {
          keep_entity_ids: data.resolved_favorites.map((f) => f.id),
          area_tag_ids: data.candidate_tags.slice(0, 1).map((t) => t.id),
          food_tag_ids: [],
          activity_tag_ids: [],
          weekend_radius_km: 250,
          common_ground: ["artist"],
          reasoning: "Kept all matches.",
        };
      }
      const first = data.first_week_candidates.map((c) => ({ id: c.id, why: `Because you love ${c.because[0] || "good food"}.` }));
      if (hallucinate) first.push({ id: "MADE-UP-PLACE", why: "Invented." });
      return {
        headline: "Welcome to Fayetteville",
        summary: "Two sentences. Grounded in Qloo.",
        areas: data.areas.map((a) => ({ id: a.id, why: "Matches your taste." })),
        first_week: first,
        kids: data.kids_candidates.map((c) => ({ id: c.id, why: "Kid friendly." })),
        weekend: data.weekend_candidates.map((c) => ({ id: c.id, why: "Short drive." })),
        common_ground: data.common_ground_candidates.map((c) => ({ id: c.id, why: "Locals love it." })),
      };
    },
  };
}
