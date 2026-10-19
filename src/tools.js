import {
  entityMatchScore,
  formatLatLon,
  localityScore,
  pickBest,
  tagMatchScore,
} from "./grounding.js";

// The tools the agent can call. Each tool talks to Qloo and returns compact,
// JSON-safe results. Every entity that reaches the final kit comes from here,
// so the app never recommends a place that Qloo didn't return.

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
      // Take several hits: the first name match is sometimes the wrong country
      // (live 2026-10-13: "San Antonio, Texas" -> Guanajuato before Bexar County).
      const hits = await qloo.search(name, { types: "urn:entity:locality", take: 5 });
      const best = pickBest(hits, (h) => localityScore(name, h), { minScore: 0.4 });
      if (!best) return null;
      const h = best.item;
      return {
        id: h.id,
        name: h.name,
        lat: h.lat,
        lon: h.lon,
        placeKind: h.placeKind || null,
        score: Math.round(best.score * 1000) / 1000,
      };
    },

    async resolve_favorites({ items, nearLocality }) {
      // /search filter.location must be "lat,lon" (not an entity id). Radius is miles.
      const near = nearLocality && nearLocality.lat != null ? nearLocality : null;
      const loc = near ? formatLatLon(near.lat, near.lon) : null;
      const resolved = await Promise.all(
        (items || []).slice(0, 12).map(async (it) => {
          const type = typeForKind(it.kind);
          const base = { types: type || undefined, take: 5 };
          try {
            let hits = [];
            if (type === "urn:entity:place" && loc) {
              hits = await qloo.search(it.name, { ...base, location: loc, radiusMiles: 40 });
            }
            if (!hits.length) {
              hits = await qloo.search(it.name, base);
            }
            const best = pickBest(
              hits,
              (h) => entityMatchScore(it.name, h, { nearLat: near?.lat, nearLon: near?.lon }),
              { minScore: 0.34 },
            );
            if (!best) return { input: it.name, kind: it.kind, id: null };
            return { input: it.name, kind: it.kind, matchScore: Math.round(best.score * 1000) / 1000, ...pick(best.item) };
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
          const tags = await qloo.tags(q, { take: 5 });
          // Live API can return unrelated siblings (e.g. "Dining" for "hiking").
          const best = pickBest(tags, (t) => tagMatchScore(q, t), { minScore: 0.34 });
          if (best) out.push({ query: q, ...best.item });
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

// Group heatmap cells into areas of about 5 km and rank them by mean affinity,
// with a small boost for popularity so busier areas rank a little higher.
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

// Name every area. When a name repeats across areas (often the city, if Qloo has no
// neighborhood) or falls back to "Area N", use "Around <top place>" instead: the first
// place Qloo returned in that area. An area with no places keeps "Area N".
export function labelAreas(placesPerArea) {
  const names = placesPerArea.map((places, i) => nameArea(places, `Area ${i + 1}`));
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return names.map((n, i) => {
    const top = placesPerArea[i]?.[0]?.name;
    const weak = counts.get(n) > 1 || /^Area \d+$/.test(n);
    return weak && top ? `Around ${top}` : n;
  });
}
