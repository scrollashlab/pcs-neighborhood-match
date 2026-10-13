// Thin Qloo API client for the hackathon environment.
// Docs: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide

export const QLOO_BASE = "https://hackathon.api.qloo.com";

export const ENTITY_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:video_game",
];

export class QlooError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = "QlooError";
    this.status = status;
    this.path = path;
  }
}

export class QlooClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey   hackathon key, sent as X-Api-Key
   * @param {Function} [opts.fetch] fetch implementation (injectable for tests)
   * @param {object} [opts.cache]  object with get(key) / put(key, value) promises
   * @param {number} [opts.timeoutMs]
   */
  constructor({ apiKey, fetch: fetchImpl, cache, timeoutMs = 12000, baseUrl = QLOO_BASE }) {
    if (!apiKey) throw new Error("QLOO_API_KEY is not set");
    this.apiKey = apiKey;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.cache = cache || null;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.calls = 0;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const url = `${this.baseUrl}${path}?${qs.toString()}`;
    if (this.cache) {
      const hit = await this.cache.get(url);
      if (hit) return hit;
    }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        this.calls++;
        const res = await this.fetch(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new QlooError(`Qloo ${res.status}`, res.status, path);
          await sleep(400 * (attempt + 1));
          continue;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = body?.error?.message || body?.message || `Qloo ${res.status}`;
          throw new QlooError(msg, res.status, path);
        }
        if (this.cache) await this.cache.put(url, body);
        return body;
      } catch (err) {
        if (err instanceof QlooError) throw err;
        lastErr = err;
        await sleep(300 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new QlooError("Qloo request failed", 0, path);
  }

  /** Entity search by name. Returns a list of normalized entities. */
  async search(query, { types, take = 5, location, radiusMiles } = {}) {
    const body = await this.get("/search", {
      query,
      types,
      take,
      "filter.location": location,
      "filter.radius": radiusMiles,
    });
    return listOf(body).map(normalizeEntity);
  }

  /** Tag search, e.g. "hiking" -> urn:tag:... ids. */
  async tags(query, { take = 5, tagTypes } = {}) {
    const body = await this.get("/v2/tags", {
      "filter.query": query,
      "filter.tag.types": tagTypes,
      "feature.typo_tolerance": true,
      take,
    });
    return listOf(body).map((t) => ({
      id: t.id || t.tag_id || t.entity_id,
      name: t.name || t.id,
      type: t.type || t.subtype || null,
    })).filter((t) => t.id);
  }

  /** Raw insights call. Returns { entities, heatmap, query }. */
  async insights(params) {
    const body = await this.get("/v2/insights", params);
    const results = body?.results || {};
    return {
      entities: (results.entities || []).map(normalizeEntity),
      heatmap: (results.heatmap || []).map(normalizeHeatCell),
      query: body?.query || {},
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.results?.tags)) return body.results.tags;
  if (Array.isArray(body?.results?.entities)) return body.results.entities;
  if (Array.isArray(body?.tags)) return body.tags;
  return [];
}

export function normalizeEntity(e = {}) {
  const p = e.properties || {};
  const loc = e.location || {};
  const ancestors = (p.ancestors || []).map((a) => ({
    id: a.entity_id || a.id || null,
    name: a.name || null,
    abbreviation: a.abbreviation || null,
    place: a.place || null,
    adminLevel: a.admin_level ?? null,
  }));
  return {
    id: e.entity_id || e.id,
    name: e.name,
    type: e.subtype || (Array.isArray(e.types) ? e.types[0] : e.type) || null,
    address: p.address || null,
    city: p.geocode?.city || p.geocode?.name || null,
    neighborhood: p.geocode?.neighborhood || p.neighborhood || null,
    priceLevel: p.price_level ?? null,
    rating: p.business_rating ?? null,
    website: p.website || null,
    image: p.image?.url || null,
    description: p.description || p.short_description || null,
    lat: loc.lat ?? loc.latitude ?? null,
    lon: loc.lon ?? loc.lng ?? loc.longitude ?? null,
    geohash: loc.geohash || e.geohash || null,
    placeKind: p.place || null,
    ancestors,
    tags: (e.tags || []).slice(0, 8).map((t) => ({ id: t.id || t.tag_id, name: t.name })),
    affinity: e.query?.affinity ?? null,
    explain: parseExplainability(e.query?.explainability),
  };
}

export function normalizeHeatCell(c = {}) {
  const loc = c.location || {};
  return {
    lat: loc.latitude ?? loc.lat ?? null,
    lon: loc.longitude ?? loc.lon ?? loc.lng ?? null,
    geohash: loc.geohash || null,
    affinity: c.query?.affinity ?? null,
    affinityRank: c.query?.affinity_rank ?? null,
    popularity: c.query?.popularity ?? null,
  };
}

// Explainability arrives as nested objects keyed by signal; collect every
// { entity_id, score } pair we can find so the UI can say "because you loved X".
export function parseExplainability(x) {
  if (!x || typeof x !== "object") return [];
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const id = node.entity_id || node.id;
    const score = node.score ?? node.weight ?? node.value;
    if (id && typeof score === "number") out.push({ id, score });
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
  };
  walk(x);
  const best = new Map();
  for (const { id, score } of out) best.set(id, Math.max(score, best.get(id) ?? 0));
  return [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
