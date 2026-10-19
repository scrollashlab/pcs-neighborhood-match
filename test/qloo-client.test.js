import assert from "node:assert/strict";
import test from "node:test";
import { QlooClient, TtlCache, retryAfterMs } from "../src/qloo.js";

// A fake clock: sleep() advances time instead of waiting.
function clock() {
  let t = 1_000_000;
  const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, advance: (ms) => { t += ms; }, waits };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(fetch, c, extra = {}) {
  return new QlooClient({ apiKey: "k", fetch, now: c.now, sleep: c.sleep, random: () => 1, ...extra });
}

test("429 backs off exponentially (full jitter ceiling 300, 600, 1200 ms) and then succeeds", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => (++n < 4 ? json({}, 429) : json({ results: [] })), c);
  assert.deepEqual(await q.search("x"), []);
  assert.equal(n, 4);
  assert.deepEqual(c.waits, [300, 600, 1200]);
  assert.equal(q.stats.rateLimited, 3);
  assert.equal(q.stats.retries, 3);
});

test("jitter draws each wait between 0 and the ceiling", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => (++n < 3 ? json({}, 429) : json({ results: [] })), c, { random: () => 0.5 });
  await q.search("x");
  assert.deepEqual(c.waits, [150, 300]);
});

test("Retry-After in seconds is honored instead of the backoff", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => (++n < 2 ? json({}, 429, { "retry-after": "2" }) : json({ results: [] })), c);
  await q.search("x");
  assert.deepEqual(c.waits, [2000]);
});

test("Retry-After as an HTTP date is honored", () => {
  const now = Date.parse("2026-10-18T20:00:00Z");
  assert.equal(retryAfterMs("Sun, 18 Oct 2026 20:00:03 GMT", now), 3000);
  assert.equal(retryAfterMs("garbage", now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test("retries stop at the time cap: a Retry-After past the cap gives up without waiting", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => (n++, json({}, 429, { "retry-after": "30" })), c);
  await assert.rejects(() => q.search("x"), (e) => e.status === 429);
  assert.equal(n, 1);
  assert.deepEqual(c.waits, []);
  assert.equal(q.stats.gaveUp, 1);
});

test("retries stop at maxAttempts and total waiting stays under maxTotalMs", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => (n++, json({}, 503)), c, { maxTotalMs: 10000 });
  await assert.rejects(() => q.search("x"), (e) => e.status === 503);
  assert.equal(n, 4);
  assert.ok(c.waits.reduce((a, b) => a + b, 0) <= 10000);
});

test("a slow API counts against the cap too: no attempt starts after maxTotalMs", async () => {
  const c = clock();
  const starts = [];
  const q = client(async () => { starts.push(c.now() - 1_000_000); c.advance(4000); return json({}, 429); }, c, { maxTotalMs: 10000 });
  await assert.rejects(() => q.search("x"), (e) => e.status === 429);
  assert.ok(starts.length <= 3);
  assert.ok(starts.every((t) => t < 10000));
});

test("each attempt's timeout is clipped to the time left under the cap", async () => {
  let seen;
  const realSetTimeout = globalThis.setTimeout;
  const c = clock();
  globalThis.setTimeout = (fn, ms) => { seen = ms; return realSetTimeout(() => {}, 0); };
  try {
    const q = client(async () => json({ results: [] }), c, { timeoutMs: 12000, maxTotalMs: 10000 });
    await q.search("x");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(seen, 10000);
});

test("cache hit avoids a second fetch", async () => {
  const c = clock();
  let n = 0;
  const cache = new TtlCache({ ttlMs: 60000, now: c.now });
  const q = client(async () => (n++, json({ results: [{ entity_id: "A", name: "A" }] })), c, { cache });
  await q.search("x");
  await q.search("x");
  assert.equal(n, 1);
  assert.equal(q.stats.cacheHits, 1);
});

test("cache entries expire after the TTL", async () => {
  const c = clock();
  let n = 0;
  const cache = new TtlCache({ ttlMs: 60000, now: c.now });
  const q = client(async () => (n++, json({ results: [] })), c, { cache });
  await q.search("x");
  c.advance(60001);
  await q.search("x");
  assert.equal(n, 2);
});

test("cache is bounded: the oldest entry is evicted", () => {
  const cache = new TtlCache({ ttlMs: 60000, max: 2 });
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});

test("4xx and 5xx responses are never cached", async () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 60000, now: c.now });
  let n = 0;
  const q400 = client(async () => (n++, json({ error: { message: "bad" } }, 400)), c, { cache });
  await assert.rejects(() => q400.search("x"));
  await assert.rejects(() => q400.search("x"));
  assert.equal(n, 2);
  let m = 0;
  const q500 = client(async () => (m++, json({}, 500)), c, { cache, maxAttempts: 1 });
  await assert.rejects(() => q500.search("y"));
  await assert.rejects(() => q500.search("y"));
  assert.equal(m, 2);
  assert.equal(cache.size, 0);
});

test("network errors are retried with backoff", async () => {
  const c = clock();
  let n = 0;
  const q = client(async () => { if (++n < 2) throw new Error("socket hang up"); return json({ results: [] }); }, c);
  await q.search("x");
  assert.equal(n, 2);
  assert.deepEqual(c.waits, [300]);
});
