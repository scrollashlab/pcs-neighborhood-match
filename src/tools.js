// The tools the agent can call. Each tool talks to Qloo and returns compact,
// JSON-safe results. Every entity that reaches the final kit comes from here,
// which is how the app guarantees it never recommends a place Qloo didn't return.

const KIND_TO_TYPE = {
  place: "urn:entity:place",
  restaurant: "urn:entity:place",
  artist: "urn:entity:artist",
  music: "urn:entity:artist",
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  show: "urn:entity:tv_show",
  book: "urn:entity:book",
  podcast: "urn:entity:podcast",
  brand: "urn:entity:brand",
  video_game: "urn:entity:video_game",
  destination: "urn:entity:destination",
};

export function typeForKind(kind) {
  return KIND_TO_TYPE[String(kind || "").toLowerCase()] || null;
}

// Geohash prefix of length 5 is roughly a 5 km x 5 km cell: a good "area" size
// for choosing where to live near a base.
const AREA_PRECISION = 5;

export function makeTools(qloo) {
  return {
    async resolve_locality({ name }) {
      const hits = await qloo.search(name, { types: "urn:entity:locality", take: 1 });
      return hits[0] ? { id: hits[0].id, name: hits[0].name } : null;
    },

    async resolve_favorites({ items, nearLocalityId }) {
      const resolved = await Promise.all(
        (items || []).slice(0, 12).map(async (it) => {
          const type = typeForKind(it.kind);
          const opts = { types: type || undefined, take: 1 };
          if (type === "urn:entity:place" && nearLocalityId) opts.location = nearLocalityId;
          try {
            const [hit] = await qloo.search(it.name, opts);
            if (!hit && opts.location) {
              const [loose] = await qloo.search(it.name, { types: type || undefined, take: 1 });
              return loose ? { input: it.name, kind: it.kind, ...pick(loose) } : { input: it.name, kind: it.kind, id: null };
            }
            return hit ? { input: it.name, kind: it.kind, ...pick(hit) } : { input: it.name, kind: it.kind, id: null };
          } catch {
            return { input: it.name, kind: it.kind, id: null };
          }
        }),
      );
      return resolved;
    },

    async find_tags({ queries }) {
      const out = [];
      for (const q of (queries || []).slice(0, 6)) {
        try {
          const tags = await qloo.tags(q, { take: 3 });
          if (tags[0]) out.push({ query: q, ...tags[0] });
        } catch {
          /* a missing tag is not fatal */
        }
      }
      return out;
    },

    async taste_heatmap({ locality, entityIds, tagIds, areas = 4 }) {
      const params = {
        "filter.type": "urn:heatmap",
        "filter.location.query": locality,
        "filter.location.radius": 25000,
        "signal.interests.entities": (entityIds || []).slice(0, 15),
        "signal.interests.tags": (tagIds || []).slice(0, 5),
      };
      const { heatmap } = await qloo.insights(params);
      return rankAreas(heatmap, areas);
    },

    async places_in_area({ geohash, locality, entityIds, tagIds, priceMax, take = 6 }) {
      const params = {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": (entityIds || []).slice(0, 15),
        "signal.interests.tags": (tagIds || []).slice(0, 5),
        "feature.explainability": true,
        "filter.price_level.max": priceMax || undefined,
        take,
      };
      if (geohash) params["filter.location.geohash"] = geohash;
      else params["filter.location.query"] = locality;
      const { entities } = await qloo.insights(params);
      return entities.map(pick);
    },

    async weekend_destinations({ locality, entityIds, radiusKm = 300, take = 5 }) {
      const { entities } = await qloo.insights({
        "filter.type": "urn:entity:destination",
        "filter.location.query": locality,
        "filter.location.radius": Math.round(radiusKm * 1000),
        "signal.interests.entities": (entityIds || []).slice(0, 15),
        "feature.explainability": true,
        take,
      });
      return entities.map(pick);
    },

    async local_common_ground({ locality, entityIds, type = "urn:entity:artist", take = 5 }) {
      const { entities } = await qloo.insights({
        "filter.type": type,
        "signal.location.query": locality,
        "signal.interests.entities": (entityIds || []).slice(0, 15),
        "feature.explainability": true,
        take,
      });
      return entities.map(pick);
    },
  };
}

function pick(e) {
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    address: e.address,
    city: e.city,
    neighborhood: e.neighborhood,
    priceLevel: e.priceLevel,
    rating: e.rating,
    website: e.website,
    image: e.image,
    description: e.description,
    lat: e.lat,
    lon: e.lon,
    geohash: e.geohash,
    tags: e.tags,
    affinity: e.affinity,
    explain: e.explain,
  };
}

// Group heatmap cells into ~5 km areas and rank by mean affinity, lightly
// weighted toward places that are actually lived in (popularity).
export function rankAreas(cells, limit = 4) {
  const groups = new Map();
  for (const c of cells || []) {
    if (!c.geohash || c.affinity == null) continue;
    const key = c.geohash.slice(0, AREA_PRECISION);
    const g = groups.get(key) || { geohash: key, n: 0, aff: 0, pop: 0, lat: 0, lon: 0 };
    g.n++;
    g.aff += c.affinity;
    g.pop += c.popularity ?? 0;
    g.lat += c.lat ?? 0;
    g.lon += c.lon ?? 0;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      geohash: g.geohash,
      affinity: round(g.aff / g.n),
      popularity: round(g.pop / g.n),
      lat: round(g.lat / g.n, 5),
      lon: round(g.lon / g.n, 5),
      cells: g.n,
      score: round(0.8 * (g.aff / g.n) + 0.2 * (g.pop / g.n)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function round(x, d = 3) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// Name an area from the places Qloo returned inside it.
export function nameArea(places, fallback) {
  const counts = new Map();
  for (const p of places || []) {
    const n = p.neighborhood || p.city;
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  if (places?.[0]?.name) return `Around ${places[0].name}`;
  return fallback;
}
