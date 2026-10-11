// Local UI preview with synthetic Qloo responses (no API key, no network).
// Run `npm run preview:mock` and open http://localhost:8787.
// The data shown is made up by test/fake-qloo.js; use `npm run dev` with a real
// key in .dev.vars to see real recommendations.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeFetch } from "../test/fake-qloo.js";
import worker from "../src/worker.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const realFetch = globalThis.fetch;
const mock = fakeFetch();
globalThis.fetch = (url, init) => (String(url).startsWith("https://hackathon.api.qloo.com") ? mock(url, init) : realFetch(url, init));

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = join(root, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file.startsWith(root)) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:8787${req.url}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : body });
  const response = await worker.fetch(request, { QLOO_API_KEY: "synthetic", ASSETS });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, () => console.log("Mock preview on http://localhost:8787 (synthetic data)"));
