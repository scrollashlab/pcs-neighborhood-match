import assert from "node:assert/strict";
import test from "node:test";
import { heuristicProfile, runAgent, sanitizeInput, UserError } from "../src/agent.js";
import { parseJsonLoose } from "../src/llm.js";
import { QLOO_BASE, QlooClient, parseExplainability } from "../src/qloo.js";
import { labelAreas, nameArea, rankAreas } from "../src/tools.js";
import { fakeFetch, fakeLlm } from "./fake-qloo.js";

const FORM = {
  stationId: "fort-bragg",
  homeCity: "San Antonio, Texas",
  places: "Rudy's BBQ, Mi Tierra Cafe",
  music: "George Strait",
  screen: "Bluey",
  activities: "hiking, live music",
  kids: "young",
  budget: "2",
};

const client = (opts = {}) => new QlooClient({ apiKey: "test-key", fetch: fakeFetch(opts), timeoutMs: 2000 });

test("Qloo client uses the hackathon base URL and the X-Api-Key header", async () => {
  const log = [];
  const q = new QlooClient({ apiKey: "k-123", fetch: fakeFetch({ log }) });
  await q.search("George Strait", { types: "urn:entity:artist" });
  assert.equal(QLOO_BASE, "https://hackathon.api.qloo.com");
  assert.equal(log[0].path, "/search");
  assert.equal(log[0].headers["X-Api-Key"], "k-123");
});

test("Qloo client retries on 429 and then succeeds", async () => {
  let n = 0;
  const flaky = async () => (++n < 2 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ results: [] }), { status: 200 }));
  const q = new QlooClient({ apiKey: "k", fetch: flaky });
  const out = await q.search("x");
  assert.deepEqual(out, []);
  assert.equal(n, 2);
});

test("Qloo client surfaces 4xx errors without retrying", async () => {
  let n = 0;
  const bad = async () => (n++, new Response(JSON.stringify({ error: { message: "bad param" } }), { status: 400 }));
  const q = new QlooClient({ apiKey: "k", fetch: bad });
  await assert.rejects(() => q.insights({ "filter.type": "urn:entity:place" }), /bad param/);
  assert.equal(n, 1);
});

test("parseJsonLoose pulls JSON out of fenced or chatty model output", () => {
  assert.deepEqual(parseJsonLoose('Sure!\n```json\n{"a": {"b": "}"}}\n```'), { a: { b: "}" } });
  assert.throws(() => parseJsonLoose("no json here"));
});

test("parseExplainability collects and ranks contributing entities", () => {
  const out = parseExplainability({ "signal.interests.entities": [{ entity_id: "A", score: 0.2 }, { entity_id: "B", score: 0.6 }], extra: { nested: { entity_id: "A", score: 0.4 } } });
  assert.deepEqual(out, [{ id: "B", score: 0.6 }, { id: "A", score: 0.4 }]);
});

test("rankAreas groups heatmap cells into ~5 km areas", () => {
  const areas = rankAreas([
    { geohash: "dnrgaaaa", affinity: 0.9, popularity: 0.5, lat: 1, lon: 1 },
    { geohash: "dnrgaaab", affinity: 0.7, popularity: 0.5, lat: 3, lon: 3 },
    { geohash: "dnrgbbbb", affinity: 0.5, popularity: 0.1, lat: 5, lon: 5 },
  ]);
  assert.equal(areas.length, 2);
  assert.equal(areas[0].geohash, "dnrga");
  assert.equal(areas[0].cells, 2);
  assert.equal(areas[0].lat, 2);
});

test("nameArea prefers the most common neighborhood or city", () => {
  assert.equal(nameArea([{ city: "A" }, { neighborhood: "B" }, { neighborhood: "B" }], "x"), "B");
  assert.equal(nameArea([{ name: "Cafe" }], "x"), "Around Cafe");
  assert.equal(nameArea([], "Area 1"), "Area 1");
});

test("sanitizeInput clamps sizes and enums", () => {
  const s = sanitizeInput({ places: "x".repeat(1000), kids: "lots", budget: "9" });
  assert.equal(s.places.length, 400);
  assert.equal(s.kids, "none");
  assert.equal(s.budget, 3);
});

test("heuristic profile types each field", () => {
  const p = heuristicProfile(sanitizeInput(FORM));
  assert.deepEqual(p.favorites.map((f) => f.kind), ["place", "place", "artist", "tv_show"]);
  assert.deepEqual(p.interests, ["hiking", "live music"]);
  assert.equal(p.kids, true);
});

test("agent builds a full kit without a model (fallback path)", async () => {
  const out = await runAgent(FORM, { qloo: client(), llm: null });
  assert.equal(out.destination.locality, "Fayetteville, North Carolina");
  assert.ok(out.kit.areas.length >= 1);
  assert.equal(out.kit.areas[0].name, "Haymount");
  assert.ok(out.kit.first_week.length > 0);
  assert.ok(out.kit.weekend.length > 0);
  assert.ok(out.kit.common_ground.length > 0);
  assert.ok(out.kit.kids.length > 0);
  assert.match(out.kit.first_week[0].why, /Rudy's BBQ/);
  assert.equal(out.stats.llmSteps, 0);
});

test("agent with a model keeps only Qloo-returned items (drops invented IDs)", async () => {
  const out = await runAgent(FORM, { qloo: client(), llm: fakeLlm({ hallucinate: true }) });
  assert.equal(out.stats.llmSteps, 3);
  assert.equal(out.kit.headline, "Welcome to Fayetteville");
  assert.ok(!out.kit.first_week.some((e) => e.id === "MADE-UP-PLACE"));
  assert.ok(out.kit.first_week.every((e) => e.id.startsWith("PLACE-")));
});

test("agent falls back cleanly when the model allocation is exhausted", async () => {
  const out = await runAgent(FORM, { qloo: client(), llm: fakeLlm({ fail: true }) });
  assert.equal(out.stats.llmSteps, 0);
  assert.ok(out.trace.some((t) => /Model unavailable/.test(t.detail)));
  assert.ok(out.kit.first_week.length > 0);
});

test("agent broadens and retries when the first heatmap is empty", async () => {
  const out = await runAgent(FORM, { qloo: client({ emptyFirstHeatmap: true }), llm: null });
  assert.ok(out.kit.areas.length >= 1);
  assert.ok(out.trace.some((t) => t.step === "retry" && /Where to live/.test(t.detail)));
});

test("agent asks for a destination and at least one favorite", async () => {
  await assert.rejects(() => runAgent({ places: "x y" }, { qloo: client(), llm: null }), UserError);
  await assert.rejects(() => runAgent({ stationId: "fort-bragg" }, { qloo: client(), llm: null }), UserError);
});

test("free-text city works when no preset is chosen", async () => {
  const out = await runAgent({ ...FORM, stationId: "", otherCity: "Dothan, Alabama" }, { qloo: client(), llm: null });
  assert.equal(out.destination.locality, "Dothan, Alabama");
});

test("model text is cleaned of dash punctuation and exclamation marks", async () => {
  const { plain } = await import("../src/agent.js");
  assert.equal(plain("Great tacos \u2014 near the gate!"), "Great tacos, near the gate.");
  assert.equal(plain("Quiet streets \u2013 good parks"), "Quiet streets, good parks");
});

test("family with no activities and no kids still gets named areas and first-week places", async () => {
  const log = [];
  const q = new QlooClient({ apiKey: "test-key", fetch: fakeFetch({ log }), timeoutMs: 2000 });
  const out = await runAgent({ ...FORM, activities: "", kids: "none" }, { qloo: q, llm: null });
  assert.ok(!log.some((l) => Object.values(l.params).includes("")), "no empty query parameters sent");
  assert.ok(out.kit.areas.length >= 1);
  assert.ok(out.kit.areas.every((a) => !/^Area \d+$/.test(a.name)));
  assert.equal(out.kit.areas[0].name, "Haymount");
  assert.ok(out.kit.first_week.length > 0);
  assert.equal(out.kit.kids.length, 0);
});

test("labelAreas uses 'Around <top place>' when area names repeat", () => {
  const names = labelAreas([
    [{ name: "Cafe One", city: "Fayetteville" }, { name: "Diner", city: "Fayetteville" }],
    [{ name: "Taco Two", city: "Fayetteville" }],
    [{ name: "Bakery", neighborhood: "Haymount" }],
  ]);
  assert.deepEqual(names, ["Around Cafe One", "Around Taco Two", "Haymount"]);
});

test("labelAreas keeps 'Area N' only for an area with no places", () => {
  const names = labelAreas([[], [{ name: "Park Grill", city: "Spring Lake" }]]);
  assert.deepEqual(names, ["Area 1", "Spring Lake"]);
});

test("agent gives each area a distinct name when the city repeats", async () => {
  const out = await runAgent(FORM, { qloo: client(), llm: null });
  const names = out.kit.areas.map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[0], "Haymount");
  assert.ok(names.slice(1).every((n) => n.startsWith("Around PLACE ")));
});

test("broadened first-week retry keeps the budget filter", async () => {
  const log = [];
  const q = new QlooClient({ apiKey: "test-key", fetch: fakeFetch({ log, emptyFirstBudgetPlaces: true }), timeoutMs: 2000 });
  const out = await runAgent(FORM, { qloo: q, llm: null });
  assert.ok(out.trace.some((t) => t.step === "retry" && /First week/.test(t.detail)));
  const budgeted = log.filter((l) => l.path === "/v2/insights" && l.params["filter.type"] === "urn:entity:place" && l.params["filter.price_level.max"]);
  assert.ok(budgeted.length >= 2, "first query and retry both carry the budget");
  assert.ok(budgeted.every((l) => l.params["filter.price_level.max"] === "2"));
  assert.ok(budgeted.some((l) => !l.params["signal.interests.tags"]), "the retry drops tags but not the budget");
  assert.ok(out.kit.first_week.length > 0);
});
