// Grounding helpers: pick the right Qloo entity or tag for free-text input.
// Live API (2026-10-13): /search filter.location must be "lat,lon", not an
// entity id. Name-first locality hits can also be the wrong country, so we
// score with ancestor state/country and US-state hints from the query.

const US_STATE_TOKENS = new Set(
  [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
    "ohio", "oklahoma", "oregon", "pennsylvania", "tennessee", "texas", "utah", "vermont",
    "virginia", "washington", "wisconsin", "wyoming",
    // abbreviations only (multi-word states use US_STATE_PHRASES)
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
    "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
    "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
    "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
  ],
);

// "new mexico" / "north carolina" etc. — keep multi-word US hints as phrases too.
const US_STATE_PHRASES = [
  "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "south carolina", "north dakota", "south dakota",
  "rhode island", "west virginia", "district of columbia",
];

export function normalizeTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Fraction of query tokens that appear in the candidate name (0..1). */
export function tokenScore(query, name) {
  const q = normalizeTokens(query);
  const n = new Set(normalizeTokens(name));
  if (!q.length || !n.size) return 0;
  return q.filter((t) => n.has(t)).length / q.length;
}

export function queryImpliesUS(query) {
  const lower = String(query || "").toLowerCase();
  if (US_STATE_PHRASES.some((p) => lower.includes(p))) return true;
  const tokens = normalizeTokens(query);
  // Require a clear state signal; bare "new"/"north" alone is not enough.
  return tokens.some((t) => US_STATE_TOKENS.has(t) && t.length >= 2);
}

function ancestorBlob(entity) {
  const parts = [];
  for (const a of entity?.ancestors || []) {
    if (a?.name) parts.push(a.name);
    if (a?.abbreviation) parts.push(a.abbreviation);
  }
  return parts.join(" ");
}

function inConusOrAlaskaHawaii(lat, lon) {
  if (lat == null || lon == null) return false;
  // Contiguous US + generous AK/HI boxes.
  if (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) return true;
  if (lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129) return true; // Alaska
  if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) return true; // Hawaii
  return false;
}

/**
 * Score a locality search hit for a free-text city query.
 * Higher is better. Wrong-country hits that merely echo the state in the
 * name (e.g. "San Antonio Texas" in Guanajuato) score below real US cities.
 */
export function localityScore(query, entity) {
  if (!entity?.name) return 0;
  let score = tokenScore(query, entity.name);
  const anc = ancestorBlob(entity);
  const ancTokens = new Set(normalizeTokens(anc));
  const qTokens = normalizeTokens(query);

  // Boost when query state/country tokens appear in ancestors (not just the name).
  const stateHits = qTokens.filter((t) => t.length > 2 && ancTokens.has(t)).length;
  score += 0.35 * Math.min(1, stateHits);

  if (queryImpliesUS(query)) {
    const usa = /\bunited states\b|\busa\b/i.test(anc);
    if (usa) score += 0.5;
    if (inConusOrAlaskaHawaii(entity.lat, entity.lon)) score += 0.35;
    else if (entity.lat != null) score -= 0.8; // known coords outside the US
  }

  // Prefer city over neighborhood/quarter when names are otherwise close.
  if (entity.placeKind === "city") score += 0.1;
  if (entity.placeKind === "quarter" || entity.placeKind === "neighbourhood") score -= 0.15;

  return score;
}

/**
 * Score a place/artist/etc. search hit against the typed favorite.
 * Prefers name overlap; lightly prefers candidates nearer the home lat/lon.
 */
export function entityMatchScore(query, entity, { nearLat = null, nearLon = null } = {}) {
  if (!entity?.name) return 0;
  let score = tokenScore(query, entity.name);
  // Soft exactness boost when the matched name starts with the query.
  const q = normalizeTokens(query).join(" ");
  const n = normalizeTokens(entity.name).join(" ");
  if (n === q) score += 0.25;
  else if (n.startsWith(q) || q.startsWith(n)) score += 0.1;

  if (nearLat != null && nearLon != null && entity.lat != null && entity.lon != null) {
    const dlat = entity.lat - nearLat;
    const dlon = entity.lon - nearLon;
    const dist2 = dlat * dlat + dlon * dlon;
    // Within ~0.5 deg (~55 km) gets a small boost; far away is slightly docked.
    if (dist2 < 0.25) score += 0.2;
    else if (dist2 > 25) score -= 0.15;
  }
  return score;
}

export function tagMatchScore(query, tag) {
  if (!tag?.name && !tag?.id) return 0;
  const nameScore = tokenScore(query, tag.name || "");
  // Prefer tags whose id slug contains a query token (e.g. hiking in urn:tag:...:hiking).
  const idBlob = String(tag.id || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const idScore = tokenScore(query, idBlob);
  return Math.max(nameScore, idScore * 0.9);
}

export function pickBest(items, scoreFn, { minScore = 0.34 } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items || []) {
    const s = scoreFn(item);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  if (!best || bestScore < minScore) return null;
  return { item: best, score: bestScore };
}

export function formatLatLon(lat, lon) {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return `${Number(lat)},${Number(lon)}`;
}
