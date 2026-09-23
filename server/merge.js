// Sticky Board — the room document.
//
// One server means one total order, so merging is simpler than it looks: whoever's patch arrives
// last wins, per entity. That is enough because clients only ever send entities they actually
// changed (they diff against the last state the server confirmed), so nobody echoes a stale value
// back over someone else's newer one. Two people dragging different notes both land; two people
// editing the same note's text is last-writer-wins, which is the accepted trade for a workshop.
//
// Every accepted change bumps `seq` and is recorded per key, which is what lets a client that
// dropped its connection ask for "everything since 42" instead of refetching the whole board.

"use strict";

const { toEntities, fromEntities, parseKey } = require("./entities");
const { validateEntity } = require("./validate");

/** Facilitation is the facilitator's to run; participants may not patch these at all. */
const FACILITATOR_ONLY = new Set(["brainstorm"]);

/**
 * A vote entity carries two different things: how the vote is run, which is the facilitator's, and
 * everyone's ballots, which are their own. So a participant's patch is not refused outright — it
 * is narrowed to their own ballot and applied on top of what the room already has.
 * Returns null when there is nothing they may legitimately change.
 */
function mergeVote(prev, next, by) {
  if (!prev) return null;                       // only the facilitator opens a vote
  const mine = (next.voters || []).find(v => v.by === by);
  const others = (prev.voters || []).filter(v => v.by !== by);
  return {
    status: prev.status,
    type: prev.type,
    startedAt: prev.startedAt,
    dotsPerVoter: prev.dotsPerVoter,
    voters: mine ? [...others, mine] : others,
  };
}

function createDoc(state) {
  return { entities: toEntities(state), seqs: Object.create(null), tombs: Object.create(null), seq: 0 };
}

function docToState(doc) {
  return fromEntities(doc.entities);
}

/**
 * Apply a patch from one peer.
 *
 * @param doc      the room document
 * @param entities {key: value | null}; null deletes
 * @param opts     {by, facilitator}
 * @returns {applied, rejected, seq} — `applied` is what to broadcast, already sanitised.
 */
function applyPatch(doc, entities, opts = {}) {
  const by = opts.by || "";
  const applied = Object.create(null);
  const rejected = [];
  let touched = false;

  for (const key of Object.keys(entities)) {
    const k = parseKey(key);
    if (!k) { rejected.push([key, "bad-key"]); continue; }
    if (FACILITATOR_ONLY.has(k.type) && !opts.facilitator) { rejected.push([key, "not-facilitator"]); continue; }
    if (k.type === "vote" && !opts.facilitator && entities[key] === null) { rejected.push([key, "not-facilitator"]); continue; }

    let raw = entities[key];

    if (raw === null) {
      // A deletion only sticks if there is something to delete; a repeat is silently fine.
      if (!(key in doc.entities) && doc.tombs[key]) continue;
      if (!touched) { doc.seq++; touched = true; }
      delete doc.entities[key];
      doc.seqs[key] = doc.seq;
      doc.tombs[key] = doc.seq;
      applied[key] = null;
      continue;
    }

    // Everyone casts their own ballot; nobody but the facilitator changes how the vote is run.
    // The ballot is checked against the vote the room is actually running rather than the one the
    // sender describes, or claiming "type: thumbs" would quietly rewrite their own dots.
    if (k.type === "vote" && !opts.facilitator) {
      const prev = doc.entities[key];
      if (!prev) { rejected.push([key, "not-facilitator"]); continue; }
      raw = { ...prev, voters: (raw && Array.isArray(raw.voters)) ? raw.voters : [] };
    }

    let clean = validateEntity(key, raw);
    if (!clean) { rejected.push([key, "invalid"]); continue; }

    if (k.type === "vote" && !opts.facilitator) {
      clean = mergeVote(doc.entities[key], clean, by);
      if (!clean) { rejected.push([key, "not-facilitator"]); continue; }
      if (stableish(doc.entities[key]) === stableish(clean)) continue;
    }

    // A note's author is set once, by the server, from the connection that created it. A client
    // cannot claim to have written someone else's note, which is what keeps face-down notes
    // private (see redactFor).
    if (k.type === "note") {
      const prev = doc.entities[key];
      if (prev && prev.by) clean.by = prev.by;
      else if (by) clean.by = by;
      else delete clean.by;
      // Everyone but the author was only ever sent a blank copy of a face-down note, so their
      // patches must never write that blank back over the real words. Without this, dragging
      // somebody's face-down note — or the facilitator pressing "Reveal all", which patches every
      // note from a screen where they all read as empty — quietly destroys the brainstorm.
      if (prev && prev.hidden && prev.by !== by) clean.text = prev.text;
    }

    if (!touched) { doc.seq++; touched = true; }
    doc.entities[key] = clean;
    doc.seqs[key] = doc.seq;
    delete doc.tombs[key];
    applied[key] = clean;
  }

  return { applied, rejected, seq: doc.seq };
}

/**
 * Hide face-down notes from everyone but their author.
 *
 * The single-file app already excludes hidden notes from search, exports and the side panel, but
 * over a network that is not enough: the text must never reach another device in the first place,
 * or a curious participant reads the whole silent brainstorm out of the socket. So the server
 * blanks it and says only that a note is there. Revealing clears `hidden`, and the real text goes
 * out with that same patch.
 */
function redactFor(entities, viewer) {
  let out = null;
  for (const key of Object.keys(entities)) {
    const e = entities[key];
    if (!e || !e.hidden || !key.startsWith("note:")) continue;
    if (e.by && e.by === viewer) continue;
    if (!out) out = { ...entities };
    out[key] = { ...e, text: "" };
  }
  return out || entities;
}

/**
 * Everything that changed after `since`, redacted for this viewer. Null when a full state is due.
 * `since` of 0 is a first join, not a resume: a new room has no sequence numbers recorded yet, so
 * a delta from 0 would be empty and the joiner would sit there holding its own board instead.
 */
function deltaSince(doc, since, viewer) {
  if (!Number.isFinite(since) || since < 1 || since > doc.seq) return null;
  const out = Object.create(null);
  for (const key of Object.keys(doc.seqs)) {
    if (doc.seqs[key] <= since) continue;
    out[key] = key in doc.entities ? doc.entities[key] : null;
  }
  return redactFor(out, viewer);
}

/** The whole board as this viewer is allowed to see it. */
function snapshotFor(doc, viewer) {
  return redactFor(doc.entities, viewer);
}

/** Tombstones are only needed to answer "what changed since?"; drop the ones nobody can ask about. */
function pruneTombs(doc, keepSince) {
  for (const key of Object.keys(doc.tombs)) {
    if (doc.tombs[key] <= keepSince) { delete doc.tombs[key]; delete doc.seqs[key]; }
  }
}

/** Cheap deep-equality for deciding whether a narrowed patch actually changed anything. */
function stableish(v) {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableish).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableish(v[k])).join(",") + "}";
}

module.exports = { createDoc, docToState, applyPatch, redactFor, deltaSince, snapshotFor, pruneTombs, mergeVote, FACILITATOR_ONLY };
