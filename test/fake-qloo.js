// Synthetic stand-in for the Qloo API used by the tests. All names and IDs
// here are made up; no real Qloo response data is stored in this repository.

export function fakeFetch({ emptyFirstHeatmap = false, log = [] } = {}) {
  let heatmapCalls = 0;
  return async (url, init) => {
    const u = new URL(url);
    log.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init?.headers });
    const p = u.searchParams;
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (u.pathname === "/search") {
      const q = p.get("query");
      if (p.get("types") === "urn:entity:locality") return ok({ results: [{ entity_id: "LOC-HOME", name: q }] });
      if (q === "Nothing Matches") return ok({ results: [] });
      return ok({ results: [{ entity_id: `ENT-${slug(q)}`, name: `${q} (matched)`, subtype: p.get("types") || "urn:entity:artist" }] });
    }
    if (u.pathname === "/v2/tags") {
      const q = p.get("filter.query");
      return ok({ results: { tags: [{ id: `urn:tag:test:${slug(q)}`, name: q, type: "urn:tag:test" }] } });
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
