// Sticky Board — document <-> entity map
//
// Collaboration merges per entity, never per document: two people dragging different notes must
// both land. This module splits a board document into independently addressable entities and
// puts it back together again.
//
// The page keeps a copy of this logic (src/sticky-board.html, "collaboration" section) because it
// is a single file with no module loading. The key grammar and the entity shapes below ARE the
// wire format — change them in both places or rooms and clients stop agreeing.
//
// Keys
//   meta                 project name, snap, legend, link defaults
//   board:<bid>          a board's name and its place in the tab order
//   note:<bid>:<id>      one note
//   frame:<bid>:<id>     one frame
//   link:<bid>:<id>      one link
//   park:<id>            one parking-lot item
//   vote:<bid>           the vote on a board (absent = no vote)
//   brainstorm:<bid>     the silent brainstorm on a board (absent = not running)
//
// `activeBoard` is deliberately NOT an entity: which board tab you are looking at is yours alone.

"use strict";

const K = {
  meta: () => "meta",
  board: b => `board:${b}`,
  note: (b, id) => `note:${b}:${id}`,
  frame: (b, id) => `frame:${b}:${id}`,
  link: (b, id) => `link:${b}:${id}`,
  park: id => `park:${id}`,
  vote: b => `vote:${b}`,
  brainstorm: b => `brainstorm:${b}`,
};

/** "note:abc:def" -> {type:"note", board:"abc", id:"def"}; null if the key is malformed. */
function parseKey(key) {
  const parts = String(key).split(":");
  const type = parts[0];
  if (type === "meta" && parts.length === 1) return { type, board: null, id: null };
  if ((type === "board" || type === "vote" || type === "brainstorm") && parts.length === 2 && parts[1]) {
    return { type, board: parts[1], id: parts[1] };
  }
  if (type === "park" && parts.length === 2 && parts[1]) return { type, board: null, id: parts[1] };
  if ((type === "note" || type === "frame" || type === "link") && parts.length === 3 && parts[1] && parts[2]) {
    return { type, board: parts[1], id: parts[2] };
  }
  return null;
}

/** Split a normalised document into {key: entity}. */
function toEntities(state) {
  const out = Object.create(null);
  out[K.meta()] = {
    project: state.project,
    snap: !!state.snap,
    legend: { ...(state.legend || {}) },
    linkDefaults: { ...(state.linkDefaults || {}) },
  };
  // A document posted from outside has not been through normalise(), so nothing here may assume a
  // field is present. Anything missing is simply an empty collection.
  const list = v => (Array.isArray(v) ? v : []);
  list(state.boards).forEach((b, i) => {
    if (!b || !b.id) return;
    out[K.board(b.id)] = { id: b.id, name: b.name, order: i };
    list(b.notes).forEach(n => { if (n && n.id) out[K.note(b.id, n.id)] = { ...n }; });
    list(b.frames).forEach(f => { if (f && f.id) out[K.frame(b.id, f.id)] = { ...f }; });
    list(b.links).forEach(l => { if (l && l.id) out[K.link(b.id, l.id)] = { ...l }; });
    if (b.vote) out[K.vote(b.id)] = { ...b.vote };
    if (b.brainstorm) out[K.brainstorm(b.id)] = { ...b.brainstorm };
  });
  list(state.parking).forEach(p => { if (p && p.id) out[K.park(p.id)] = { ...p }; });
  return out;
}

/**
 * Rebuild a document from {key: entity}. Entities whose board has gone are dropped, as are links
 * whose endpoints have gone — the same rules normalise() applies on the client.
 * Always returns at least one board, so the result is a document the app can open.
 */
function fromEntities(map) {
  const meta = map[K.meta()] || {};
  const boards = [];
  const byId = new Map();

  for (const key of Object.keys(map)) {
    const k = parseKey(key);
    if (!k || k.type !== "board") continue;
    const e = map[key];
    const b = { id: k.id, name: e.name, order: Number.isFinite(e.order) ? e.order : 0, notes: [], frames: [], links: [], vote: null, brainstorm: null };
    boards.push(b);
    byId.set(k.id, b);
  }

  for (const key of Object.keys(map)) {
    const k = parseKey(key);
    if (!k) continue;
    const b = k.board ? byId.get(k.board) : null;
    const e = map[key];
    switch (k.type) {
      case "note": if (b) b.notes.push({ ...e }); break;
      case "frame": if (b) b.frames.push({ ...e }); break;
      case "link": if (b) b.links.push({ ...e }); break;
      case "vote": if (b) b.vote = { ...e }; break;
      case "brainstorm": if (b) b.brainstorm = { ...e }; break;
      default: break;
    }
  }

  boards.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  boards.forEach(b => {
    delete b.order;
    b.notes.sort((x, y) => (x.z || 0) - (y.z || 0));
    const ids = new Set(b.notes.map(n => n.id));
    b.links = b.links.filter(l => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  });
  if (!boards.length) boards.push({ id: "b" + Math.random().toString(36).slice(2, 10), name: "Current", notes: [], frames: [], links: [], vote: null, brainstorm: null });

  const parking = [];
  for (const key of Object.keys(map)) {
    const k = parseKey(key);
    if (k && k.type === "park") parking.push({ ...map[key] });
  }
  parking.sort((a, b) => String(a.parkedAt).localeCompare(String(b.parkedAt)));

  return {
    format: "sticky-board",
    version: 2,
    project: meta.project || "Untitled project",
    snap: !!meta.snap,
    legend: { ...(meta.legend || {}) },
    linkDefaults: { ...(meta.linkDefaults || {}) },
    parking,
    activeBoard: boards[0].id,
    boards,
  };
}

/** Deterministic JSON, so two entities that mean the same thing compare equal. */
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

/** Keys in `next` whose value differs from `prev`; removed keys map to null (a deletion). */
function diffEntities(prev, next) {
  const out = Object.create(null);
  for (const k of Object.keys(next)) {
    if (!(k in prev) || stable(prev[k]) !== stable(next[k])) out[k] = next[k];
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) out[k] = null;
  }
  return out;
}

module.exports = { K, parseKey, toEntities, fromEntities, stable, diffEntities };
