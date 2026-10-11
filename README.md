# PCS Neighborhood Match

A web app for military families on PCS (permanent change of station) orders. The family lists what
they like at home: restaurants, music, shows, books and weekend activities. An agent uses the Qloo
API to suggest the areas near the new base that match those tastes, places to try in the first week,
weekend trips, and local favorites the family is likely to share with new neighbors.

## The problem

Military families move every two to three years, often with only a few weeks' notice. Most choose a
neighborhood without seeing it, using base housing handouts and forum threads. Rent and drive time
are easy to compare. Whether the family will like living there is much harder to judge,
and it matters most to spouses and children, who did not choose the move.

A general chatbot can list popular neighborhoods near Fort Bragg. It cannot tell a family that likes
Texas barbecue, George Strait and hiking which part of Fayetteville draws people with the same tastes.
Qloo's taste data can.

## What it does

1. **Areas that match your taste.** A Qloo heatmap of the area around the new base, seeded with the
   family's favorites. Cells are grouped into areas of about 5 km, ranked, named after places Qloo
   returns inside them, and shown on a map.
2. **Your first week.** Restaurants, cafes and venues near the base that match the places the family
   will miss, within their eating-out budget. Each one shows which favorite led to it, using Qloo's
   explainability data.
3. **For the kids.** Family-friendly places, shown when the family has children.
4. **Weekend trips.** Destinations within driving range that fit what the family enjoys.
5. **Common ground.** Artists and shows that are popular locally and also fit the family's taste.

The kit prints cleanly to PDF for the family's PCS binder.

## How the agent works

The agent runs five steps. The app lists each step, with timings, under "How the agent built this."

| Step | What happens | Qloo endpoints |
|---|---|---|
| Understand | The model turns free text ("Rudy's, Tejano, Bluey, beach days") into typed favorites and interests. | none |
| Ground | Tools look up each favorite as a Qloo entity and each interest as a Qloo tag. Place searches are centered on the family's current city. | `/search`, `/v2/tags` |
| Plan | The model checks the matches, drops wrong ones (a song instead of a band), picks the tags that matter for housing, food and activities, and sets how far to look for weekend trips. | none |
| Execute | Tools query Qloo in parallel. A query that comes back empty is broadened and retried. | `/v2/insights` with `urn:heatmap`, `urn:entity:place`, `urn:entity:destination`, `urn:entity:artist`, `urn:entity:tv_show`; `signal.interests.entities`, `signal.interests.tags`, `signal.location.query`, `filter.location.query`, `filter.location.geohash`, `filter.price_level.max`, `feature.explainability` |
| Brief | The model writes the kit using only tool results. A validator removes any item whose ID did not come from Qloo, so the agent cannot invent a restaurant. | none |

Every model step has a fallback that needs no model. If the free model allowance runs out, the app
still builds the kit from Qloo results with fixed wording, and the step list says so.

## Architecture

- **Cloudflare Worker** (`src/worker.js`) serves the page and the `/api/kit` endpoint on the free plan.
- **Workers AI** runs the model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default; set
  `LLM_MODEL` to change it). It uses the free daily allowance and cannot bill on the Workers Free plan.
- **Qloo hackathon API** (`https://hackathon.api.qloo.com`) is called through `src/qloo.js`, which
  retries on 429 and 5xx responses and caches results in memory. The key is a Worker secret and never
  reaches the browser.
- **Front end** in plain HTML, CSS and JavaScript (`public/`), with a Leaflet map on OpenStreetMap tiles.

```
browser -> POST /api/kit -> Worker -> agent.js -> tools.js -> Qloo API
                                   -> Workers AI (understand, plan, brief)
```

## Run it

You need Node.js 22 or later, and a free Cloudflare account to deploy.

```bash
npm install
npm test                 # unit tests, no network
npm run preview:mock     # page preview with made-up data at http://localhost:8787
```

With a Qloo hackathon key:

```bash
cp .dev.vars.example .dev.vars   # then add your key to .dev.vars
npm run dev                      # wrangler dev with Workers AI
```

Deploy:

```bash
npx wrangler secret put QLOO_API_KEY
npm run deploy
```

## Privacy

There are no accounts and no database. The form text goes to the Worker, is used for one request,
and is held only in a short-lived memory cache so a repeat request does not query Qloo again. The
app does not ask for names or addresses. No Qloo responses are stored in this repository; the tests
use made-up data in `test/fake-qloo.js`.

## Limits

- Qloo has less taste data for small towns. When matches are weak, the app says so instead of guessing.
- Use this as a starting point. Visit the area and talk to the installation housing office before
  signing a lease.

## License

MIT. See [LICENSE](LICENSE).
