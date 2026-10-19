// Shared by the page (app.js) and the tests: where each kit note is shown, and
// how a section list is built so a part that failed to load is never left out.

// Kit sections and the page list each note belongs to. "favorites" shows under the summary.
export const NOTE_TARGET = {
  favorites: "notes",
  areas: "areas",
  area_places: "areas",
  first_week: "first_week",
  kids: "kids_list",
  weekend: "weekend",
  common_ground: "common_ground",
};

export function notesFor(kit, target) {
  return (kit?.notes || []).filter((n) => NOTE_TARGET[n.section] === target).map((n) => n.text);
}

// Build the children of one list: notes first, then items, then the empty message
// only when nothing loaded and nothing failed. `el(tag, props, ...children)` makes a node.
export function listChildren({ items, notes = [], emptyText, itemNode, el }) {
  const out = notes.map((text) => el("li", { className: "note", role: "status", textContent: text }));
  for (const [i, e] of (items || []).entries()) out.push(itemNode(e, i));
  if (!(items || []).length && !notes.length) out.push(el("li", { className: "empty", textContent: emptyText }));
  return out;
}
