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

// Short-lived, bounded in-memory cache for successful Qloo responses, keyed by the
// full request URL. On a Worker it lives per isolate: repeated demo requests that
// land on the same isolate skip Qloo entirely. Entries expire after ttlMs; the
// oldest entry is evicted past max.
export class TtlCache {
  constructor({ ttlMs = 10 * 60 * 1000, max = 500, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expires) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  put(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  get size() {
    return this.map.size;
  }
}

// Parse Retry-After (delta seconds or an HTTP date) into milliseconds, or null.
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// Caps how many Qloo requests are in flight at once. acquire() resolves with a
// release function, or with null if no slot frees up before the deadline (epoch ms).
export class Limiter {
  constructor(max = 4) {
    this.max = max;
    this.active = 0;
    this.peak = 0;
    this.queue = [];
  }
  acquire(deadline, now = Date.now) {
    if (this.active < this.max) return Promise.resolve(this.#grant());
    const wait = deadline - now();
    if (wait <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(null);
      }, wait);
      this.queue.push(entry);
    });
  }
  #grant() {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.#grant());
      }
    };
  }
}

export class QlooClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey   hackathon key, sent as X-Api-Key
   * @param {Function} [opts.fetch] fetch implementation (injectable for tests)
   * @param {object} [opts.cache]  object with get(key) / put(key, value); see TtlCache
   * @param {number} [opts.timeoutMs]    per-attempt timeout
   * @param {number} [opts.maxAttempts]  attempts per request on 429, 5xx or network errors
   * @param {number} [opts.maxTotalMs]   cap on total time per request, retries and waits included
   * @param {number} [opts.baseDelayMs]  first backoff step; doubles each retry (full jitter)
   * @param {number} [opts.maxDelayMs]   cap on a single backoff wait
   * @param {Limiter} [opts.limiter]     shared in-flight limit (default: 4 for this client)
   * @param {number} [opts.maxConcurrent]
   */
  constructor({
    apiKey,
    fetch: fetchImpl,
    cache,
    timeoutMs = 12000,
    baseUrl = QLOO_BASE,
    maxAttempts = 6,
    maxTotalMs = 10000,
    baseDelayMs = 300,
    maxDelayMs = 4000,
    sleep: sleepImpl = sleep,
    random = Math.random,
    now = Date.now,
    limiter,
    maxConcurrent = 4,
  }) {
    if (!apiKey) throw new Error("QLOO_API_KEY is not set");
    this.apiKey = apiKey;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.cache = cache || null;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.maxAttempts = maxAttempts;
    this.maxTotalMs = maxTotalMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleep = sleepImpl;
    this.random = random;
    this.now = now;
    this.limiter = limiter || new Limiter(maxConcurrent);
    this.calls = 0;
    this.stats = { calls: 0, cacheHits: 0, retries: 0, rateLimited: 0, serverErrors: 0, waitedMs: 0, gaveUp: 0, queueTimeouts: 0, queuedMs: 0 };
  }

  backoffMs(attempt) {
    // Full jitter: a random wait between 0 and min(maxDelay, base * 2^attempt).
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.round(this.random() * ceiling);
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      // Live API answers 400 to an empty list parameter (e.g. signal.interests.tags=).
      if (Array.isArray(v) && !v.length) continue;
      qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const url = `${this.baseUrl}${path}?${qs.toString()}`;
    if (this.cache) {
      const hit = await this.cache.get(url);
      if (hit) {
        this.stats.cacheHits++;
        return hit;
      }
    }
    // One deadline per request, measured from this call: time spent queued for a
    // slot, in flight and backing off all count against maxTotalMs. A slot is held
    // only while a fetch is in flight, never during a backoff wait.
    const started = this.now();
    const deadline = started + this.maxTotalMs;
    let lastErr;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const queuedAt = this.now();
      const release = await this.limiter.acquire(deadline, this.now);
      this.stats.queuedMs += this.now() - queuedAt;
      if (!release) {
        this.stats.queueTimeouts++;
        lastErr = lastErr || new QlooError("Qloo request timed out waiting for a free slot", 0, path);
        break;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        release();
        break;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, remaining));
      let res;
      let body;
      try {
        this.calls++;
        this.stats.calls++;
        res = await this.fetch(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (res.status !== 429 && res.status < 500) body = await res.json().catch(() => ({}));
      } catch (err) {
        lastErr = err; // network error or timeout: retryable
        res = undefined;
      } finally {
        clearTimeout(timer);
        release();
      }
      let hinted = null;
      if (res) {
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429) this.stats.rateLimited++;
          else this.stats.serverErrors++;
          lastErr = new QlooError(`Qloo ${res.status}`, res.status, path);
          hinted = retryAfterMs(res.headers?.get?.("retry-after"), this.now());
        } else {
          if (!res.ok) {
            const msg = body?.error?.message || body?.message || `Qloo ${res.status}`;
            throw new QlooError(msg, res.status, path); // other 4xx: no retry, never cached
          }
          if (this.cache) await this.cache.put(url, body); // only successful responses are cached
          return body;
        }
      }
      if (attempt === this.maxAttempts - 1) break;
      const wait = hinted != null ? hinted : this.backoffMs(attempt);
      if (this.now() + wait >= deadline) break; // would blow the time cap
      this.stats.retries++;
      this.stats.waitedMs += wait;
      await this.sleep(wait);
    }
    this.stats.gaveUp++;
    throw lastErr instanceof QlooError ? lastErr : new QlooError(lastErr ? `Qloo request failed: ${lastErr.message || lastErr}` : "Qloo request failed", lastErr?.status || 0, path);
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
