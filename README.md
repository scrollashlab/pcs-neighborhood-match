# PCS Neighborhood Match

A Qloo-powered agent for military families on PCS (permanent change of station) orders. Tell it what your family loves back home. It shows which areas around your new base match your taste, where to eat and go in your first week, weekend trips worth the drive, and the local favorites you already share with your new neighbors.

## The problem

Hundreds of thousands of service members and their families move to a new duty station every year, often every two to three years. Most get a few weeks' notice and pick a neighborhood sight unseen, from base housing pamphlets, forum threads and drive-time maps. Commute and rent are easy to compare. Whether a family will actually feel at home somewhere is not, and that is what decides whether a three-year tour feels like home or like exile, especially for spouses and kids who didn't choose the move.

A general chatbot can list "popular neighborhoods near Fort Bragg." It can't tell a family that loves Texas barbecue, George Strait and hiking which part of Fayetteville is full of people like them. That takes a taste graph.

## What it does

1. **Where people with your taste live.** A Qloo heatmap of the area around the new base, seeded with the family's own favorites, grouped into roughly 5 km areas and ranked. Each area is named from the places Qloo returns inside it and shown on a map.
2. **Your first week.** Restaurants, cafes and venues near the base that match the places the family will miss, within their eating-out budget, each with the favorite that drove the match (Qloo explainability).
3. **For the kids.** Family-friendly places, when the family has kids.
4. **Weekend trips.** Destinations within driving range that fit what the family enjoys.
5. **Common ground.** Artists and shows that are loved locally *and* fit the family's taste: small talk for the unit, the school pickup line or the family readiness group.

The kit prints cleanly to PDF so it can go in the PCS binder.

## How the agent works

The agent runs a plan-and-execute loop with five steps. Each step is visible in the app under "How the agent built this."

| Step | What happens | Qloo endpoints |
|---|---|---|
| Understand | The model turns free text ("Rudy's, Tejano, Bluey, beach days") into typed favorites and interests. | none |
| Ground | Tools resolve each favorite to a Qloo entity (place searches are centered on the family's current city) and each interest to a Qloo tag. | `/search`, `/v2/tags` |
| Plan | The model checks the matches, drops wrong ones (a song instead of a band), picks which tags matter for housing, food and activities, and sets the weekend driving radius. | none |
| Execute | Tools query Qloo in parallel. Any query that comes back empty is broadened and retried automatically. | `/v2/insights` with `urn:heatmap`, `urn:entity:place`, `urn:entity:destination`, `urn:entity:artist`, `urn:entity:tv_show`; `signal.interests.entities`, `signal.interests.tags`, `signal.location.query`, `filter.location.query`, `filter.location.geohash`, `filter.price_level.max`, `feature.explainability` |
| Brief | The model writes the kit from tool results only. A validator removes any item whose ID did not come from Qloo, so the agent cannot invent a restaurant. | none |

Every model step has a deterministic fallback. If the free model allocation runs out, the app still builds the kit from Qloo results with template text and says so in the trace.

## Architecture

- **Cloudflare Worker** (`src/worker.js`) serves the static site and the `/api/kit` endpoint. Free plan.
- **Workers AI** runs the model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default, set `LLM_MODEL` to change it). Free daily allocation; on the Workers Free plan it cannot bill.
- **Qloo hackathon API** (`https://hackathon.api.qloo.com`) through `src/qloo.js`, with retries on 429/5xx and an in-memory cache. The key is a Worker secret and never reaches the browser.
- **Front end** in plain HTML, CSS and JavaScript (`public/`), with a Leaflet map on OpenStreetMap tiles.

```
browser ──POST /api/kit──► Worker ──► agent.js ──► tools.js ──► Qloo API
                                  └─► Workers AI (understand, plan, brief)
```

## Run it

Requirements: Node.js 22 or later and a free Cloudflare account for deployment.

```bash
npm install
npm test                 # unit tests, no network
npm run preview:mock     # UI preview with synthetic data at http://localhost:8787
```

With a Qloo hackathon key:

```bash
cp .dev.vars.example .dev.vars   # then put your key in .dev.vars
npm run dev                      # wrangler dev with Workers AI
```

Deploy:

```bash
npx wrangler secret put QLOO_API_KEY
npm run deploy
```

## Privacy

The app has no accounts and no database. Form text is sent to the Worker, used for one request and kept only in a short-lived in-memory cache so repeat requests don't re-query Qloo. No names or addresses are asked for. Qloo responses are not stored in this repository; the tests use synthetic data in `test/fake-qloo.js`.

## Limits

- Taste data is thinner around small towns. The agent says when Qloo has no strong matches instead of guessing.
- This is a starting point for house hunting, not a substitute for visiting, checking commute times and talking to the installation housing office.

## License

MIT. See [LICENSE](LICENSE).
