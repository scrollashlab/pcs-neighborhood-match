import { listChildren, notesFor } from "./notes.js";
const $ = (id) => document.getElementById(id);
const FIELDS = ["stationId", "otherCity", "homeCity", "places", "music", "screen", "reading", "activities", "kids", "budget"];

const EXAMPLE = {
  stationId: "fort-bragg",
  otherCity: "",
  homeCity: "San Antonio, Texas",
  places: "Rudy's BBQ, Mi Tierra Cafe, the Pearl farmers market",
  music: "George Strait, Zach Bryan, Selena",
  screen: "Bluey, Yellowstone, Top Gun: Maverick",
  reading: "Jocko Podcast",
  activities: "hiking, craft beer, live music",
  kids: "young",
  budget: "2",
};

let map;

async function loadStations() {
  try {
    const res = await fetch("/api/stations");
    const { stations } = await res.json();
    const sel = $("stationId");
    for (const s of stations) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.label;
      sel.appendChild(o);
    }
  } catch {
    /* the free-text city still works */
  }
}

function formData() {
  const out = {};
  for (const f of FIELDS) out[f] = $(f).value;
  return out;
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

const STEPS = [
  "Reading what your family loves…",
  "Finding your favorites in the Qloo taste graph…",
  "Checking the matches and planning the search…",
  "Mapping taste across the area around your new base…",
  "Writing your welcome kit…",
];

async function submit(ev) {
  ev.preventDefault();
  const btn = $("go");
  btn.disabled = true;
  $("result").hidden = true;
  let i = 0;
  setStatus(STEPS[0]);
  const timer = setInterval(() => setStatus(STEPS[Math.min(++i, STEPS.length - 1)]), 2500);
  try {
    const res = await fetch("/api/kit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formData()),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Something went wrong.");
    render(body);
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    clearInterval(timer);
    btn.disabled = false;
  }
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) if (c != null) n.append(c);
  return n;
}

function itemNode(e, index) {
  const title = e.website ? el("a", { href: e.website, target: "_blank", rel: "noopener", textContent: e.name }) : el("strong", { textContent: e.name });
  const meta = [e.address, e.priceLevel ? "$".repeat(e.priceLevel) : null].filter(Boolean).join(" · ");
  return el(
    "li",
    {},
    index != null ? el("span", { className: "badge", textContent: String(index + 1) }) : null,
    el("div", {}, title, meta ? el("div", { className: "meta", textContent: meta }) : null, e.why ? el("p", { textContent: e.why }) : null),
  );
}

const EMPTY = "Qloo didn't return strong matches here for this search.";

function fill(id, list, kit) {
  $(id).replaceChildren(...listChildren({ items: list, notes: notesFor(kit, id), emptyText: EMPTY, itemNode: (e) => itemNode(e), el }));
}

function render(data) {
  const k = data.kit;
  $("headline").textContent = k.headline;
  $("summary").textContent = k.summary;

  const generalNotes = notesFor(k, "notes");
  $("notes").hidden = !generalNotes.length;
  $("notes").replaceChildren(...generalNotes.map((text) => el("p", { className: "note", role: "status", textContent: text })));

  const areaNode = (a, i) => {
    const li = itemNode({ name: `${a.name} · ${Math.round((a.affinity || 0) * 100)}% taste match`, why: a.why }, i);
    if (a.places?.length) li.querySelector("div").append(el("div", { className: "meta", textContent: `Nearby: ${a.places.slice(0, 4).map((p) => p.name).join(", ")}` }));
    return li;
  };
  $("areas").replaceChildren(
    ...listChildren({ items: k.areas, notes: notesFor(k, "areas"), emptyText: "Qloo didn't have enough taste data to rank areas here.", itemNode: areaNode, el }),
  );

  fill("first_week", k.first_week, k);
  fill("weekend", k.weekend, k);
  fill("common_ground", k.common_ground, k);
  const kidNotes = notesFor(k, "kids_list");
  $("kids-card").hidden = !k.kids?.length && !kidNotes.length;
  if (!$("kids-card").hidden) fill("kids_list", k.kids, k);

  const trace = $("trace");
  trace.replaceChildren(...data.trace.map((t) => el("li", {}, el("strong", { textContent: `${t.step} ` }), `${t.detail} `, el("span", { className: "meta", textContent: `(${(t.ms / 1000).toFixed(1)} s)` }))));
  const matches = $("matches");
  matches.replaceChildren(
    ...data.favorites.map((f) => el("li", { textContent: f.matched ? `${f.typed}: matched to ${f.matched}` : f.failed ? `${f.typed}: couldn't look up right now` : `${f.typed}: no match` })),
  );
  $("stats").textContent = `${data.stats.qlooCalls} Qloo calls, ${data.stats.llmSteps} model steps, ${(data.stats.ms / 1000).toFixed(1)} s${data.cached ? " (cached)" : ""}.`;

  $("result").hidden = false;
  drawMap(k.areas);
  $("result").scrollIntoView({ behavior: "smooth" });
}

function drawMap(areas) {
  const pts = areas.filter((a) => a.lat != null && a.lon != null);
  const box = $("map");
  if (!window.L || !pts.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  map.eachLayer((l) => l instanceof L.CircleMarker && map.removeLayer(l));
  const bounds = [];
  pts.forEach((a, i) => {
    const ll = [a.lat, a.lon];
    bounds.push(ll);
    L.circleMarker(ll, { radius: 14 - i * 2, color: "#1f4e79", fillColor: "#2e86de", fillOpacity: 0.55, weight: 2 })
      .addTo(map)
      .bindTooltip(`${i + 1}. ${a.name}`, { permanent: i === 0 });
  });
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  setTimeout(() => map.invalidateSize(), 50);
}

$("kit-form").addEventListener("submit", submit);
$("example").addEventListener("click", () => {
  for (const [k, v] of Object.entries(EXAMPLE)) $(k).value = v;
});
$("print").addEventListener("click", () => window.print());
loadStations();
