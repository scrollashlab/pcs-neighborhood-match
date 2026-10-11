// LLM wrapper. In production this is Cloudflare Workers AI (free daily
// allocation, no billing on the Workers Free plan). Tests inject a stub.

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class LlmUnavailable extends Error {}

export function makeLlm(env) {
  if (!env?.AI) return null;
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  return {
    model,
    async json(system, user, { maxTokens = 900 } = {}) {
      let out;
      try {
        out = await env.AI.run(model, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.2,
        });
      } catch (err) {
        throw new LlmUnavailable(String(err?.message || err));
      }
      const text = typeof out === "string" ? out : out?.response ?? JSON.stringify(out?.response ?? out);
      return parseJsonLoose(text);
    },
  };
}

// Models sometimes wrap JSON in prose or code fences. Take the first balanced object.
export function parseJsonLoose(text) {
  if (text && typeof text === "object") return text;
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON in model output");
}
