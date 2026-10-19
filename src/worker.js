import { runAgent, UserError } from "./agent.js";
import { makeLlm } from "./llm.js";
import { Limiter, QlooClient, TtlCache } from "./qloo.js";
import { STATIONS } from "./stations.js";

// Small in-isolate caches: Qloo responses (10 min) and finished kits (10 min).
// They cut repeat Qloo calls, which helps with 429s, and keep the free model
// allocation for new requests. Only successful responses are cached.
const qlooCache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 500 });
const kitCache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 100 });
// At most 4 Qloo requests in flight per isolate, shared across concurrent kit requests.
const qlooLimiter = new Limiter(4);

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
        const qloo = new QlooClient({ apiKey: env.QLOO_API_KEY, cache: qlooCache, limiter: qlooLimiter });
        const result = await runAgent(input, { qloo, llm: makeLlm(env) });
        // A kit with a part that failed to load is never cached, so the next try rebuilds it.
        if (!result.kit.notes?.length) kitCache.put(key, result);
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
