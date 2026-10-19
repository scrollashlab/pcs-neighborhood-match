import assert from "node:assert/strict";
import test from "node:test";
import { NOTE_TEXT, runAgent } from "../src/agent.js";
import { Limiter, QlooClient } from "../src/qloo.js";
import worker from "../src/worker.js";
import { listChildren, notesFor } from "../public/notes.js";
import { fakeFetch } from "./fake-qloo.js";

const FORM = {
  stationId: "fort-bragg",
  homeCity: "San Antonio, Texas",
  places: "Rudy's BBQ",
  music: "George Strait",
  screen: "Bluey",
  activities: "hiking",
  kids: "young",
  budget: "2",
};
const noSleep = async () => {};
const client = (opts = {}, extra = {}) => new QlooClient({ apiKey: "k", fetch: fakeFetch(opts), timeoutMs: 2000, sleep: noSleep, ...extra });

// Minimal stand-in for document.createElement so the page's list builder can run in Node.
const el = (tag, props = {}, ...children) => ({ tag, ...props, children });
const render = (kit, target, items) =>
  listChildren({ items, notes: notesFor(kit, target), emptyText: "EMPTY", itemNode: (e) => el("li", { textContent: e.name }), el });

test("a failed weekend section carries a note in the kit and in the rendered list", async () => {
  const out = await runAgent(FORM, { qloo: client({ fail: { insights: ["urn:entity:destination"] } }), llm: null });
  assert.equal(out.kit.weekend.length, 0);
  assert.deepEqual(out.kit.notes.map((n) => n.section), ["weekend"]);
  assert.equal(out.kit.notes[0].text, "Couldn't load weekend trips right now. Try again in a minute.");
  const nodes = render(out.kit, "weekend", out.kit.weekend);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].className, "note");
  assert.equal(nodes[0].textContent, NOTE_TEXT.weekend);
  assert.ok(!nodes.some((n) => n.textContent === "EMPTY"), "a failure is not shown as 'no matches'");
  assert.ok(out.trace.some((t) => /Weekend trips: could not load after retries/.test(t.detail)));
});

test("429s that exhaust the retries become a note, not a silent gap", async () => {
  const out = await runAgent(FORM, { qloo: client({ fail: { insights: ["urn:entity:artist", "urn:entity:tv_show"] }, failStatus: 429 }), llm: null });
  assert.equal(out.kit.common_ground.length, 0);
  assert.ok(out.kit.notes.some((n) => n.section === "common_ground"));
  assert.equal(render(out.kit, "common_ground", out.kit.common_ground)[0].textContent, NOTE_TEXT.common_ground);
});

test("a failed favorites lookup is noted and marked, not shown as 'no match'", async () => {
  const out = await runAgent(FORM, { qloo: client({ fail: { search: ["urn:entity:place"] } }), llm: null });
  assert.ok(out.kit.notes.some((n) => n.section === "favorites"));
  const rudys = out.favorites.find((f) => f.typed === "Rudy's BBQ");
  assert.equal(rudys.failed, true);
  assert.deepEqual(notesFor(out.kit, "notes"), [NOTE_TEXT.favorites]);
});

test("failed kids and area-place lookups are noted in their own sections", async () => {
  const out = await runAgent(FORM, { qloo: client({ fail: { insights: ["urn:entity:place"], kidsOnly: true } }), llm: null });
  assert.ok(out.kit.notes.some((n) => n.section === "kids"));
  assert.deepEqual(notesFor(out.kit, "kids_list"), [NOTE_TEXT.kids]);
});

test("a kit with no failures has no notes, and empty sections still say 'no matches'", async () => {
  const out = await runAgent(FORM, { qloo: client(), llm: null });
  assert.deepEqual(out.kit.notes, []);
  assert.equal(render(out.kit, "weekend", [])[0].textContent, "EMPTY");
});

test("the Worker does not cache a kit that has a failed piece", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const fake = fakeFetch({ fail: { insights: ["urn:entity:destination"] } });
  globalThis.fetch = async (...a) => (calls++, fake(...a));
  try {
    const body = JSON.stringify({ ...FORM, places: "Notes Test Cafe" });
    const post = () => worker.fetch(new Request("https://example.test/api/kit", { method: "POST", body }), { QLOO_API_KEY: "k" });
    const first = await (await post()).json();
    const before = calls;
    const second = await (await post()).json();
    assert.ok(first.kit.notes.length > 0);
    assert.notEqual(second.cached, true);
    assert.ok(calls > before, "second request went back to Qloo");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("never more than 4 Qloo calls in flight, for a whole kit", async () => {
  const inflight = { now: 0, peak: 0 };
  const q = client({ inflight, delayMs: 5 });
  const out = await runAgent(FORM, { qloo: q, llm: null });
  assert.ok(out.kit.areas.length > 0);
  assert.ok(q.stats.calls > 10);
  assert.ok(inflight.peak <= 4, `peak ${inflight.peak}`);
  assert.equal(inflight.peak, 4, "the limit is actually reached under load");
  assert.ok(q.limiter.peak <= 4);
});

test("a shared limiter caps calls across clients", async () => {
  const inflight = { now: 0, peak: 0 };
  const limiter = new Limiter(4);
  const fetch = fakeFetch({ inflight, delayMs: 5 });
  const clients = [1, 2, 3].map(() => new QlooClient({ apiKey: "k", fetch, limiter, sleep: noSleep }));
  await Promise.all(clients.flatMap((c) => Array.from({ length: 6 }, (_, i) => c.search(`q${i}`, { types: "urn:entity:artist" }))));
  assert.equal(inflight.peak, 4);
});

test("time spent queued counts against the per-request cap", async () => {
  const inflight = { now: 0, peak: 0 };
  const q = new QlooClient({ apiKey: "k", fetch: fakeFetch({ inflight, delayMs: 40 }), maxConcurrent: 1, maxTotalMs: 60, sleep: noSleep });
  const results = await Promise.allSettled([1, 2, 3].map((i) => q.search(`q${i}`, { types: "urn:entity:artist" })));
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.match(String(results[2].reason.message), /free slot/);
  assert.ok(q.stats.queueTimeouts >= 1);
});

test("failed areas and first-week places are noted and rendered in their sections", async () => {
  const out = await runAgent(FORM, { qloo: client({ fail: { insights: ["urn:heatmap", "urn:entity:place"] } }), llm: null });
  const sections = out.kit.notes.map((n) => n.section);
  for (const s of ["areas", "first_week", "kids"]) assert.ok(sections.includes(s), s);
  assert.equal(render(out.kit, "areas", out.kit.areas)[0].textContent, NOTE_TEXT.areas);
  assert.equal(render(out.kit, "first_week", out.kit.first_week)[0].textContent, NOTE_TEXT.first_week);
  assert.ok(out.kit.weekend.length > 0, "the parts that loaded are still shown");
});

test("failed place lookups inside an area are noted on the areas list", async () => {
  const fetch = fakeFetch();
  const q = new QlooClient({ apiKey: "k", sleep: noSleep, fetch: async (url, init) => (new URL(url).searchParams.get("filter.location.geohash") ? new Response("{}", { status: 400 }) : fetch(url, init)) });
  const out = await runAgent(FORM, { qloo: q, llm: null });
  assert.ok(out.kit.areas.length > 0);
  assert.deepEqual(notesFor(out.kit, "areas"), [NOTE_TEXT.area_places]);
  const nodes = render(out.kit, "areas", out.kit.areas);
  assert.equal(nodes[0].className, "note");
  assert.equal(nodes.length, out.kit.areas.length + 1);
});
