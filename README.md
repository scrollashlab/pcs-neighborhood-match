# PCS Neighborhood Match

A web app for military families on PCS (permanent change of station) orders. The family lists what
they like at home: restaurants, music, shows, books and weekend activities. An agent uses the Qloo
API to suggest the areas near the new base that match those tastes, places to try in the first week,
weekend trips, and local favorites the family is likely to share with new neighbors.

## The problem

Whether a family will like living near a new base is hard to judge from far away.

For example, a family that likes Texas barbecue, George Strait and hiking can ask which parts of
Fayetteville, near Fort Bragg, draw people with the same tastes.

## What it does

1. **Areas that match your taste.** A Qloo heatmap of the area around the new base, seeded with the
   family's favorites. Cells are grouped into areas of about 5 km, ranked and shown on a map. Each
   area is labeled after places Qloo returns inside it, when it has any.
2. **Your first week.** Restaurants, cafes and venues near the base that match the places the family
   will miss, within their eating-out budget. Where Qloo returns explainability data, each one shows
   the favorite that led to it.
3. **For the kids.** Family-friendly places, shown when the family has children.
4. **Weekend trips.** Destinations within driving range that fit what the family enjoys.
5. **Common ground.** Artists and shows that are popular locally and also fit the family's taste.

The kit has a print layout for the family's PCS binder.

## How the agent works

The agent runs five steps. The app lists each step, with timings, under "How the agent built this."

| Step | What happens | Qloo endpoints |
|---|---|---|
| Understand | The model turns free text ("Rudy's, Tejano, Bluey, beach days") into typed favorites and interests. | none |
| Ground | Tools look up each favorite as a Qloo entity and each interest as a Qloo tag. When the family enters its current city, place searches use a `lat,lon` filter around it. Locality, place and tag hits are scored to catch wrong-country name matches and unrelated tags. | `/search`, `/v2/tags` |
| Plan | The model is asked to check the matches, drop wrong ones (a song instead of a band), pick the tags that matter for housing, food and activities, and set how far to look for weekend trips. Code keeps only IDs that came from the Ground step. | none |
| Execute | Tools query Qloo in parallel. Most queries that come back empty are broadened and retried. | `/v2/insights` with `urn:heatmap`, `urn:entity:place`, `urn:entity:destination`, `urn:entity:artist`, `urn:entity:tv_show`; `signal.interests.entities`, `signal.interests.tags`, `signal.location.query`, `filter.location.query`, `filter.location.geohash`, `filter.price_level.max`, `feature.explainability` |
| Brief | The model is told to write the kit from tool results only, and a validator removes any listed item whose ID did not come from Qloo, so no restaurant reaches the lists unless Qloo returned it. | none |

Every model step has a fallback that needs no model. If the free model allowance runs out, the app
still builds the kit from Qloo results with fixed wording, and the step list says so.

## Architecture

- **Cloudflare Worker** (`src/worker.js`) serves the page and the `/api/kit` endpoint. It is built to run on
  the Workers Free plan.
- **Workers AI** runs the model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default; set
  `LLM_MODEL` to change it). It is built to run within the free daily
  Workers AI allowance on the Workers Free plan.
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

With a Qloo hackathon key (env `QLOO_API_KEY`):

```bash
npm run smoke:live               # hits the real hackathon API; writes redacted samples under evidence/ (gitignored)
cp .dev.vars.example .dev.vars   # then add your key to .dev.vars
npm run dev                      # wrangler dev with Workers AI
```

Deploy:

```bash
npx wrangler secret put QLOO_API_KEY
npm run deploy
```

## Privacy

There are no accounts and no database. The form text goes to the Worker, which sends it to Workers AI
and the Qloo API to build the kit. The Worker keeps it only in a 10-minute memory cache so a repeat
request does not query Qloo again. The app does not ask for names or addresses. No Qloo responses
are stored in this repository; the tests use made-up data in `test/fake-qloo.js`.

## Limits

- When Qloo returns no matches for a section, the app says so instead of guessing.
- Use this as a starting point. Visit the area and talk to the installation housing office before
  signing a lease.

## License

MIT. See [LICENSE](LICENSE).
