#!/usr/bin/env node
// Live smoke against the Qloo hackathon API.
// Reads key/URL from ~/.secrets (or env). Never prints the key.
// Writes redacted sample responses under evidence/.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QlooClient, normalizeEntity } from "../src/qloo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EVIDENCE = join(ROOT, "evidence");

function secret(name, envName) {
  if (process.env[envName]) return process.env[envName].trim();
  const path = join(homedir(), ".secrets", name);
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`Missing secret ${name} (or env ${envName}). Store at ~/.secrets/${name}`);
  }
}

function redact(obj) {
  // Drop any accidental key-looking strings; keep structure for schema checks.
  const s = JSON.stringify(obj, (k, v) => {
    if (typeof v === "string" && /api[_-]?key/i.test(k)) return "[REDACTED]";
    if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
    return v;
  });
  return JSON.parse(s);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function summarizeEntity(e) {
  return {
    id: e.id || null,
    name: e.name || null,
    type: e.type || null,
    hasExplain: Array.isArray(e.explain) && e.explain.length > 0,
    affinity: e.affinity ?? null,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
  };
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const apiKey = secret("QLOO_HACKATHON_API_KEY", "QLOO_API_KEY");
  const baseUrl = secret("QLOO_HACKATHON_API_URL", "QLOO_API_URL") || "https://hackathon.api.qloo.com";
  assert(apiKey.length >= 20, "API key looks too short");
  assert(!apiKey.includes(" "), "API key should not contain spaces");
  assert(baseUrl.includes("hackathon.api.qloo.com"), `Unexpected base URL host: ${baseUrl}`);

  const qloo = new QlooClient({ apiKey, baseUrl, timeoutMs: 20000 });
  const report = { ok: true, baseUrl, startedAt: new Date().toISOString(), checks: [] };
  const samples = {};

  const check = async (name, fn) => {
    const started = Date.now();
    try {
      const result = await fn();
      report.checks.push({ name, ok: true, ms: Date.now() - started, ...result.meta });
      if (result.sample) samples[name] = redact(result.sample);
      console.log(`PASS  ${name}  (${Date.now() - started}ms)  ${result.meta?.summary || ""}`);
    } catch (err) {
      report.ok = false;
      report.checks.push({
        name,
        ok: false,
        ms: Date.now() - started,
        status: err?.status,
        path: err?.path,
        message: String(err?.message || err).slice(0, 200),
      });
      console.error(`FAIL  ${name}  ${err?.status || ""} ${String(err?.message || err).slice(0, 200)}`);
    }
  };

  // 1. Search — artist
  await check("search_artist", async () => {
    const hits = await qloo.search("George Strait", { types: "urn:entity:artist", take: 3 });
    assert(hits.length > 0, "expected non-empty artist search");
    assert(hits[0].id && hits[0].name, "artist hit missing id/name");
    return {
      meta: { count: hits.length, summary: `${hits.length} hits; top=${hits[0].name}` },
      sample: { count: hits.length, entities: hits.slice(0, 2).map(summarizeEntity) },
    };
  });

  // 2. Search — place (with and without location)
  let placeId = null;
  await check("search_place", async () => {
    const hits = await qloo.search("Rudy's BBQ", { types: "urn:entity:place", take: 3 });
    assert(hits.length > 0, "expected non-empty place search");
    placeId = hits[0].id;
    return {
      meta: { count: hits.length, summary: `${hits.length} hits; top=${hits[0].name}` },
      sample: { count: hits.length, entities: hits.slice(0, 2).map(summarizeEntity) },
    };
  });

  // 3. Search — locality (used for home-city centering). May 403 if unsupported.
  await check("search_locality", async () => {
    const hits = await qloo.search("San Antonio, Texas", { types: "urn:entity:locality", take: 1 });
    return {
      meta: {
        count: hits.length,
        summary: hits.length ? `top=${hits[0].name} id=${hits[0].id?.slice(0, 8)}…` : "empty (may need destination/place fallback)",
        empty: hits.length === 0,
      },
      sample: { count: hits.length, entities: hits.slice(0, 1).map(summarizeEntity) },
    };
  });

  // 4. Tags
  let tagId = null;
  await check("tags_hiking", async () => {
    const tags = await qloo.tags("hiking", { take: 3 });
    assert(tags.length > 0, "expected non-empty tags");
    assert(tags[0].id, "tag missing id");
    tagId = tags[0].id;
    return {
      meta: { count: tags.length, summary: `${tags.length} tags; top=${tags[0].name}` },
      sample: { count: tags.length, tags: tags.slice(0, 3) },
    };
  });

  await check("tags_family_friendly", async () => {
    const tags = await qloo.tags("family friendly", { take: 3 });
    assert(tags.length > 0, "expected family-friendly tag");
    return {
      meta: { count: tags.length, summary: `top=${tags[0].name}` },
      sample: { count: tags.length, tags: tags.slice(0, 2) },
    };
  });

  // Need entity IDs for insights — collect from earlier searches
  const artistHits = await qloo.search("George Strait", { types: "urn:entity:artist", take: 1 });
  const tvHits = await qloo.search("Bluey", { types: "urn:entity:tv_show", take: 1 });
  const entityIds = [artistHits[0]?.id, tvHits[0]?.id, placeId].filter(Boolean);
  assert(entityIds.length >= 1, "need at least one entity id for insights");

  // 5. Insights — heatmap
  await check("insights_heatmap", async () => {
    const { heatmap } = await qloo.insights({
      "filter.type": "urn:heatmap",
      "filter.location.query": "Fayetteville, North Carolina",
      "filter.location.radius": 25000,
      "signal.interests.entities": entityIds.slice(0, 5),
    });
    assert(heatmap.length > 0, "expected heatmap cells");
    assert(heatmap[0].geohash || (heatmap[0].lat != null), "heatmap cell missing location");
    return {
      meta: {
        count: heatmap.length,
        summary: `${heatmap.length} cells; affinity sample=${heatmap[0].affinity}`,
      },
      sample: {
        count: heatmap.length,
        cells: heatmap.slice(0, 3).map((c) => ({
          geohash: c.geohash,
          lat: c.lat,
          lon: c.lon,
          affinity: c.affinity,
          popularity: c.popularity,
        })),
      },
    };
  });

  // 6. Insights — places with explainability
  await check("insights_places", async () => {
    const { entities } = await qloo.insights({
      "filter.type": "urn:entity:place",
      "filter.location.query": "Fayetteville, North Carolina",
      "signal.interests.entities": entityIds.slice(0, 5),
      "feature.explainability": true,
      take: 5,
    });
    assert(entities.length > 0, "expected place entities");
    const withExplain = entities.filter((e) => e.explain?.length).length;
    return {
      meta: {
        count: entities.length,
        withExplain,
        summary: `${entities.length} places; ${withExplain} with explainability`,
      },
      sample: {
        count: entities.length,
        withExplain,
        entities: entities.slice(0, 2).map((e) => ({
          ...summarizeEntity(e),
          explainTop: (e.explain || []).slice(0, 2),
          address: e.address,
          neighborhood: e.neighborhood,
          priceLevel: e.priceLevel,
        })),
      },
    };
  });

  // 7. Insights — destinations
  await check("insights_destinations", async () => {
    const { entities } = await qloo.insights({
      "filter.type": "urn:entity:destination",
      "filter.location.query": "Fayetteville, North Carolina",
      "filter.location.radius": 300000,
      "signal.interests.entities": entityIds.slice(0, 5),
      "feature.explainability": true,
      take: 3,
    });
    return {
      meta: {
        count: entities.length,
        summary: entities.length ? `top=${entities[0].name}` : "empty",
        empty: entities.length === 0,
      },
      sample: { count: entities.length, entities: entities.slice(0, 2).map(summarizeEntity) },
    };
  });

  // 8. Insights — local artists (signal.location.query)
  await check("insights_local_artists", async () => {
    const { entities } = await qloo.insights({
      "filter.type": "urn:entity:artist",
      "signal.location.query": "Fayetteville, North Carolina",
      "signal.interests.entities": entityIds.slice(0, 5),
      "feature.explainability": true,
      take: 4,
    });
    return {
      meta: {
        count: entities.length,
        summary: entities.length ? `top=${entities[0].name}` : "empty",
        empty: entities.length === 0,
      },
      sample: { count: entities.length, entities: entities.slice(0, 2).map(summarizeEntity) },
    };
  });

  // 9. Insights with tags signal
  if (tagId) {
    await check("insights_places_with_tag", async () => {
      const { entities } = await qloo.insights({
        "filter.type": "urn:entity:place",
        "filter.location.query": "Fayetteville, North Carolina",
        "signal.interests.entities": entityIds.slice(0, 3),
        "signal.interests.tags": [tagId],
        "feature.explainability": true,
        take: 4,
      });
      return {
        meta: {
          count: entities.length,
          summary: entities.length ? `top=${entities[0].name}` : "empty with tag",
        },
        sample: { count: entities.length, entities: entities.slice(0, 2).map(summarizeEntity) },
      };
    });
  }

  report.qlooCalls = qloo.calls;
  report.finishedAt = new Date().toISOString();

  writeFileSync(join(EVIDENCE, "live-smoke-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(EVIDENCE, "live-smoke-samples.json"), JSON.stringify(samples, null, 2));
  console.log(`\nWrote evidence/live-smoke-report.json and evidence/live-smoke-samples.json`);
  console.log(`Total Qloo calls: ${qloo.calls}; overall ok=${report.ok}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", String(err?.message || err).slice(0, 300));
  process.exit(2);
});
