import assert from "node:assert/strict";
import test from "node:test";
import {
  entityMatchScore,
  formatLatLon,
  localityScore,
  pickBest,
  queryImpliesUS,
  tagMatchScore,
  tokenScore,
} from "../src/grounding.js";
import { makeTools } from "../src/tools.js";
import { QlooClient } from "../src/qloo.js";
import { fakeFetch } from "./fake-qloo.js";

test("tokenScore covers query tokens in the candidate name", () => {
  assert.equal(tokenScore("San Antonio, Texas", "San Antonio Texas"), 1);
  assert.ok(tokenScore("San Antonio, Texas", "San Antonio") > 0.6);
  assert.equal(tokenScore("hiking", "Dining"), 0);
});

test("queryImpliesUS detects state names and abbreviations", () => {
  assert.equal(queryImpliesUS("San Antonio, Texas"), true);
  assert.equal(queryImpliesUS("Fayetteville, NC"), true);
  assert.equal(queryImpliesUS("New Mexico"), true);
  assert.equal(queryImpliesUS("Paris"), false);
});

test("localityScore prefers the US city over a wrong-country name echo", () => {
  const query = "San Antonio, Texas";
  const wrong = {
    name: "San Antonio Texas",
    lat: 20.98,
    lon: -101.49,
    placeKind: "quarter",
    ancestors: [
      { name: "Guanajuato", place: "state", abbreviation: "Gto." },
      { name: "México", place: "country" },
    ],
  };
  const right = {
    name: "San Antonio",
    lat: 29.46,
    lon: -98.52,
    placeKind: "city",
    ancestors: [
      { name: "Texas", place: "state", abbreviation: "Tex." },
      { name: "United States of America", place: "country", abbreviation: "USA" },
    ],
  };
  assert.ok(localityScore(query, right) > localityScore(query, wrong));
  const best = pickBest([wrong, right], (h) => localityScore(query, h), { minScore: 0.4 });
  assert.equal(best.item.name, "San Antonio");
});

test("entityMatchScore prefers the nearer place when names are similar", () => {
  const query = "Rudy's BBQ";
  const far = { name: "Rudy's BBQ Shack", lat: 41.48, lon: -87.05 };
  const near = { name: "Rudy's Country Store and BBQ", lat: 29.55, lon: -98.49 };
  const nearScore = entityMatchScore(query, near, { nearLat: 29.42, nearLon: -98.49 });
  const farScore = entityMatchScore(query, far, { nearLat: 29.42, nearLon: -98.49 });
  assert.ok(nearScore > farScore);
});

test("tagMatchScore rejects unrelated sibling tags", () => {
  assert.ok(tagMatchScore("hiking", { id: "urn:tag:activities:place:hiking", name: "Hiking" }) >= 0.9);
  assert.ok(tagMatchScore("hiking", { id: "urn:tag:amenity:place:dining", name: "Dining" }) < 0.34);
});

test("formatLatLon builds the search filter.location form", () => {
  assert.equal(formatLatLon(29.4241, -98.4936), "29.4241,-98.4936");
  assert.equal(formatLatLon(null, -98), null);
});

test("resolve_locality skips the wrong-country first hit from the fake", async () => {
  const log = [];
  const qloo = new QlooClient({ apiKey: "k", fetch: fakeFetch({ log }), timeoutMs: 2000 });
  const tools = makeTools(qloo);
  const home = await tools.resolve_locality({ name: "San Antonio, Texas" });
  assert.equal(home.id, "LOC-HOME");
  assert.equal(home.lat, 29.42);
  assert.ok(home.score > 0.4);
  assert.equal(log[0].params["types"], "urn:entity:locality");
  assert.equal(log[0].params["take"], "5");
});

test("resolve_favorites centers place search on lat,lon not entity id", async () => {
  const log = [];
  const qloo = new QlooClient({ apiKey: "k", fetch: fakeFetch({ log }), timeoutMs: 2000 });
  const tools = makeTools(qloo);
  const home = await tools.resolve_locality({ name: "San Antonio, Texas" });
  const [fav] = await tools.resolve_favorites({
    items: [{ name: "Rudy's BBQ", kind: "place" }],
    nearLocality: home,
  });
  assert.ok(fav.id);
  assert.match(fav.name, /San Antonio/);
  const placeCall = log.find((c) => c.path === "/search" && c.params.query === "Rudy's BBQ");
  assert.ok(placeCall);
  assert.equal(placeCall.params["filter.location"], "29.42,-98.49");
  assert.equal(placeCall.params["filter.radius"], "40");
  assert.notEqual(placeCall.params["filter.location"], home.id);
});

test("find_tags picks the tag whose name matches the query", async () => {
  const qloo = new QlooClient({ apiKey: "k", fetch: fakeFetch(), timeoutMs: 2000 });
  const tools = makeTools(qloo);
  const tags = await tools.find_tags({ queries: ["hiking"] });
  assert.equal(tags.length, 1);
  assert.equal(tags[0].name, "hiking");
  assert.match(tags[0].id, /hiking/i);
});
