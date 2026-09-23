// Sticky Board — inbound entity validation.
//
// Mirrors normalise() in src/sticky-board.html. Nothing a client sends is trusted: a peer holds
// only a share link, not an account, so the server re-checks every field before it reaches the
// room document or any other peer. Anything that fails is dropped, not repaired into something
// surprising.

"use strict";

const { parseKey } = require("./entities");

const COLORS = ["yellow", "green", "red", "blue", "orange"];
const LINK_STYLES = ["solid", "dashed", "dotted", "dashdot", "longdash", "double"];
const LINK_COLORS = ["grey", "blue", "red", "green", "orange"];
const LINK_WIDTHS = ["thin", "normal", "thick"];
const LINK_HEADS = ["end", "both", "none"];

const MAX_TEXT = 4000;        // a sticky note is not a document
const MAX_NAME = 120;
const MAX_LEGEND = 80;
const MAX_VOTERS = 200;

const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const num = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const isId = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const obj = v => v && typeof v === "object" && !Array.isArray(v);

function linkStyle(o) {
  o = o || {};
  return {
    style: pick(o.style, LINK_STYLES, "solid"),
    color: pick(o.color, LINK_COLORS, "grey"),
    width: pick(o.width, LINK_WIDTHS, "normal"),
    heads: pick(o.heads, LINK_HEADS, "end"),
  };
}

function consensus(c) {
  if (!obj(c) || !Array.isArray(c.votes)) return null;
  const votes = c.votes.map(v => Math.round(Number(v))).filter(v => Number.isFinite(v) && v >= 0 && v <= 5).slice(0, MAX_VOTERS);
  // A check that has just started has no numbers in it yet, and that state has to survive the trip
  // or nobody else's screen ever learns there is a check running.
  if (!votes.length && !c.open) return null;
  const out = { votes, at: str(c.at, 40) };
  // A check still in progress: the app keeps the running tally off everyone's screen until the
  // facilitator shows it, so nobody's number is swayed by the ones already in.
  if (c.open) out.open = true;
  // `shown` keeps the result on everyone's screen until the facilitator dismisses it.
  if (c.shown) out.shown = true;
  // `by[i]` records who cast `votes[i]`, so a re-submission replaces a person's own number
  // instead of stacking up. Absent for legacy files and for numbers typed in by the facilitator.
  if (Array.isArray(c.by)) out.by = c.by.slice(0, votes.length).map(v => (isId(v) ? v : ""));
  return out;
}

const V = {
  meta(e) {
    if (!obj(e)) return null;
    const legend = {};
    COLORS.forEach(c => { legend[c] = str(obj(e.legend) ? e.legend[c] : "", MAX_LEGEND); });
    return {
      project: str(e.project, MAX_NAME) || "Untitled project",
      snap: !!e.snap,
      legend,
      linkDefaults: linkStyle(e.linkDefaults),
    };
  },

  board(e, k) {
    if (!obj(e)) return null;
    return { id: k.id, name: str(e.name, MAX_NAME) || "Board", order: num(e.order, 0, 9999, 0) };
  },

  note(e, k) {
    if (!obj(e)) return null;
    const out = {
      id: k.id,
      x: num(e.x, -100000, 100000, 0),
      y: num(e.y, -100000, 100000, 0),
      w: num(e.w, 60, 4000, 120),
      h: num(e.h, 60, 4000, 124),
      color: pick(e.color, COLORS, "yellow"),
      text: str(e.text, MAX_TEXT),
      z: num(e.z, 0, 1000000, 1),
    };
    if (e.hidden) out.hidden = true;
    if (e.done) out.done = true;
    if (isId(e.by)) out.by = e.by;          // author, used to keep face-down notes private
    const c = consensus(e.consensus);
    if (c) out.consensus = c;
    return out;
  },

  frame(e, k) {
    if (!obj(e)) return null;
    return {
      id: k.id,
      x: num(e.x, -100000, 100000, 0),
      y: num(e.y, -100000, 100000, 0),
      w: num(e.w, 120, 8000, 360),
      h: num(e.h, 96, 8000, 240),
      title: str(e.title, MAX_NAME),
    };
  },

  link(e, k) {
    if (!obj(e) || !isId(e.from) || !isId(e.to) || e.from === e.to) return null;
    return { id: k.id, from: e.from, to: e.to, label: str(e.label, MAX_NAME), ...linkStyle(e) };
  },

  park(e, k) {
    if (!obj(e) || typeof e.text !== "string") return null;
    const out = {
      id: k.id,
      text: str(e.text, MAX_TEXT),
      color: pick(e.color, COLORS, "yellow"),
      w: num(e.w, 60, 4000, 120),
      h: num(e.h, 60, 4000, 120),
      from: str(e.from, MAX_NAME),
      parkedAt: str(e.parkedAt, 40),
    };
    if (e.done) out.done = true;
    const c = consensus(e.consensus);
    if (c) out.consensus = c;
    return out;
  },

  vote(e) {
    if (!obj(e) || !Array.isArray(e.voters)) return null;
    const status = pick(e.status, ["active", "closed"], null);
    if (!status) return null;
    const type = pick(e.type, ["dots", "thumbs"], "dots");
    const voters = e.voters.slice(0, MAX_VOTERS).map(vo => {
      const out = {};
      if (isId(vo && vo.by)) out.by = vo.by;   // identifies a person's own ballot across patches
      if (type === "thumbs") {
        out.thumbs = {};
        Object.entries(obj(vo) && obj(vo.thumbs) ? vo.thumbs : {}).forEach(([id, val]) => {
          if (isId(id) && (val === 1 || val === -1)) out.thumbs[id] = val;
        });
      } else {
        out.dots = {};
        Object.entries(obj(vo) && obj(vo.dots) ? vo.dots : {}).forEach(([id, c]) => {
          const n = Math.round(Number(c));
          if (isId(id) && Number.isFinite(n) && n > 0 && n <= 999) out.dots[id] = n;
        });
      }
      return out;
    });
    return { status, type, startedAt: str(e.startedAt, 40), dotsPerVoter: num(e.dotsPerVoter, 1, 20, 3), voters };
  },

  brainstorm(e) {
    if (!obj(e) || !e.active) return null;
    return { active: true, startedAt: str(e.startedAt, 40) };
  },
};

/**
 * Validate one inbound entity.
 * Returns the sanitised entity, or null when the value was a deletion or failed validation —
 * the caller tells the two apart by whether the raw value was null.
 */
function validateEntity(key, value) {
  const k = parseKey(key);
  if (!k) return null;
  if (k.id !== null && !isId(k.id)) return null;
  if (k.board !== null && !isId(k.board)) return null;
  const fn = V[k.type];
  return fn ? fn(value, k) : null;
}

module.exports = { validateEntity, parseKeyChecked: parseKey, isId, COLORS };
