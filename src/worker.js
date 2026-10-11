import { runAgent, UserError } from "./agent.js";
import { makeLlm } from "./llm.js";
import { QlooClient } from "./qloo.js";
import { STATIONS } from "./stations.js";

// Small in-isolate caches: Qloo responses and finished kits. They cut repeat
// Qloo calls and keep the free model allocation for new requests.
const qlooCache = lruCache(500);
const kitCache = lruCache(100);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, qloo: Boolean(env.QLOO_API_KEY), llm: Boolean(env.AI) });
      }
      if (url.pathname === "/api/stations") {
        return json({ stations: STATIONS.map(({ id, label }) => ({ id, label })) });
      }
      if (url.pathname === "/api/kit" && request.method === "POST") {
        const len = Number(request.headers.get("content-length") || 0);
        if (len > 8000) return json({ error: "Request too large." }, 413);
        const input = await request.json().catch(() => null);
        if (!input || typeof input !== "object") return json({ error: "Send the form as JSON." }, 400);
        const key = JSON.stringify(input);
        const cached = kitCache.get(key);
        if (cached) return json({ ...cached, cached: true });
        const qloo = new QlooClient({ apiKey: env.QLOO_API_KEY, cache: qlooCache });
        const result = await runAgent(input, { qloo, llm: makeLlm(env) });
        kitCache.put(key, result);
        return json(result);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof UserError) return json({ error: err.message }, 422);
      console.error("kit failed", err?.stack || err);
      return json({ error: "Something went wrong building your kit. Please try again in a minute." }, 502);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function lruCache(limit) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    put(k, v) {
      m.set(k, v);
      if (m.size > limit) m.delete(m.keys().next().value);
    },
  };
}
