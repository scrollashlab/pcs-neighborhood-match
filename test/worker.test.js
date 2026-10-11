import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const req = (path, init) => new Request(`https://example.test${path}`, init);

test("health reports configuration without exposing secrets", async () => {
  const res = await worker.fetch(req("/api/health"), { QLOO_API_KEY: "secret" });
  const body = await res.json();
  assert.deepEqual(body, { ok: true, qloo: true, llm: false });
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("stations endpoint lists presets", async () => {
  const res = await worker.fetch(req("/api/stations"), {});
  const { stations } = await res.json();
  assert.ok(stations.length >= 20);
  assert.ok(stations.every((s) => s.id && s.label));
});

test("kit endpoint rejects bad bodies and empty forms", async () => {
  let res = await worker.fetch(req("/api/kit", { method: "POST", body: "nope" }), { QLOO_API_KEY: "k" });
  assert.equal(res.status, 400);
  res = await worker.fetch(req("/api/kit", { method: "POST", body: JSON.stringify({ stationId: "fort-bragg" }) }), { QLOO_API_KEY: "k" });
  assert.equal(res.status, 422);
});

test("unknown API routes return 404", async () => {
  const res = await worker.fetch(req("/api/nope"), {});
  assert.equal(res.status, 404);
});
