// The merge layer is the one piece of Sticky Board where a bug loses someone's work silently,
// and it is pure functions over plain objects, so it is worth testing properly.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { toEntities, fromEntities, diffEntities, parseKey } = require("../server/entities");
const { createDoc, docToState, applyPatch, deltaSince, snapshotFor } = require("../server/merge");

const doc0 = () => createDoc(fromEntities({
  meta: { project: "Workshop", snap: true, legend: {}, linkDefaults: {} },
  "board:b1": { id: "b1", name: "Current", order: 0 },
  "note:b1:n1": { id: "n1", x: 0, y: 0, w: 120, h: 124, color: "yellow", text: "one", z: 1 },
  "note:b1:n2": { id: "n2", x: 200, y: 0, w: 120, h: 124, color: "green", text: "two", z: 2 },
}));

const alice = { by: "alice", facilitator: true };
const bob = { by: "bob", facilitator: false };

test("a document survives the round trip through entities", () => {
  const state = docToState(doc0());
  const again = fromEntities(toEntities(state));
  assert.deepEqual(again, state);
});

test("boards keep their tab order, and notes their stacking order", () => {
  const s = fromEntities({
    "board:b2": { id: "b2", name: "Second", order: 1 },
    "board:b1": { id: "b1", name: "First", order: 0 },
    "note:b1:n2": { id: "n2", z: 5, text: "top" },
    "note:b1:n1": { id: "n1", z: 1, text: "bottom" },
  });
  assert.deepEqual(s.boards.map(b => b.name), ["First", "Second"]);
  assert.deepEqual(s.boards[0].notes.map(n => n.text), ["bottom", "top"]);
});

test("two people dragging different notes both land", () => {
  const doc = doc0();
  const n1 = { ...doc.entities["note:b1:n1"], x: 50 };
  const n2 = { ...doc.entities["note:b1:n2"], x: 999 };
  applyPatch(doc, { "note:b1:n1": n1 }, alice);
  applyPatch(doc, { "note:b1:n2": n2 }, bob);
  assert.equal(doc.entities["note:b1:n1"].x, 50);
  assert.equal(doc.entities["note:b1:n2"].x, 999);
});

test("the same note edited twice is last-writer-wins, not a merge", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n1": { ...doc.entities["note:b1:n1"], text: "alice" } }, alice);
  applyPatch(doc, { "note:b1:n1": { ...doc.entities["note:b1:n1"], text: "bob" } }, bob);
  assert.equal(doc.entities["note:b1:n1"].text, "bob");
});

test("a patch that changes nothing does not burn a sequence number", () => {
  const doc = doc0();
  const before = doc.seq;
  const r = applyPatch(doc, { "note:b1:zz": 42, "wat:b1": {} }, alice);
  assert.equal(doc.seq, before, "an invalid entity must not advance the clock");
  assert.deepEqual(r.rejected.map(x => x[1]).sort(), ["bad-key", "invalid"]);
});

test("deleting leaves a tombstone so late joiners learn about it", () => {
  const doc = doc0();
  const { applied } = applyPatch(doc, { "note:b1:n1": null }, alice);
  assert.deepEqual(Object.keys(applied), ["note:b1:n1"]);
  assert.equal(applied["note:b1:n1"], null);
  assert.ok(!("note:b1:n1" in doc.entities));
  assert.ok(doc.tombs["note:b1:n1"]);
  assert.equal(docToState(doc).boards[0].notes.length, 1);
});

test("a delta carries only what changed since, deletions included", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n1": { ...doc.entities["note:b1:n1"], text: "before the mark" } }, alice);
  const mark = doc.seq;
  applyPatch(doc, { "note:b1:n1": { ...doc.entities["note:b1:n1"], text: "edited" } }, alice);
  applyPatch(doc, { "note:b1:n2": null }, alice);
  const d = deltaSince(doc, mark, "alice");
  assert.deepEqual(Object.keys(d).sort(), ["note:b1:n1", "note:b1:n2"]);
  assert.equal(d["note:b1:n1"].text, "edited");
  assert.equal(d["note:b1:n2"], null);
});

test("a first join gets the whole board, never an empty delta", () => {
  // A brand new room has no sequence numbers recorded, so treating `since: 0` as a resume point
  // would hand the joiner nothing — and leave them sitting on their own board instead of the
  // room's, which then gets pushed over everyone else's.
  const doc = doc0();
  assert.equal(deltaSince(doc, 0, "alice"), null, "since 0 must mean 'send me everything'");
  applyPatch(doc, { "note:b1:n1": { ...doc.entities["note:b1:n1"], text: "x" } }, alice);
  assert.equal(deltaSince(doc, 0, "alice"), null);
  assert.notEqual(deltaSince(doc, 1, "alice"), null, "a real resume point still gets a delta");
});

test("a delta from the future means the client is out of step and needs everything", () => {
  const doc = doc0();
  assert.equal(deltaSince(doc, doc.seq + 5, "alice"), null);
  assert.equal(deltaSince(doc, -1, "alice"), null);
});

test("a participant cannot start, stop or tamper with a vote", () => {
  const doc = doc0();
  const vote = { status: "active", type: "dots", startedAt: "", dotsPerVoter: 3, voters: [] };
  const r = applyPatch(doc, { "vote:b1": vote }, bob);
  assert.deepEqual(r.rejected, [["vote:b1", "not-facilitator"]]);
  assert.ok(!("vote:b1" in doc.entities));
  applyPatch(doc, { "vote:b1": vote }, alice);
  assert.equal(doc.entities["vote:b1"].status, "active");
});

test("a participant cannot end someone else's silent brainstorm", () => {
  const doc = doc0();
  const r = applyPatch(doc, { "brainstorm:b1": { active: true } }, bob);
  assert.equal(r.rejected[0][1], "not-facilitator");
});

test("a face-down note reaches its author in full and everyone else blank", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n3": { id: "n3", text: "my secret idea", hidden: true } }, bob);
  assert.equal(snapshotFor(doc, "bob")["note:b1:n3"].text, "my secret idea");
  assert.equal(snapshotFor(doc, "alice")["note:b1:n3"].text, "");
  assert.equal(snapshotFor(doc, "alice")["note:b1:n3"].hidden, true, "others still see that a note is there");
});

test("redaction does not damage the stored document", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n3": { id: "n3", text: "secret", hidden: true } }, bob);
  snapshotFor(doc, "alice");
  assert.equal(doc.entities["note:b1:n3"].text, "secret");
});

test("revealing a brainstorm releases the text", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n3": { id: "n3", text: "secret", hidden: true } }, bob);
  const revealed = { ...doc.entities["note:b1:n3"] };
  delete revealed.hidden;
  applyPatch(doc, { "note:b1:n3": revealed }, alice);
  assert.equal(snapshotFor(doc, "alice")["note:b1:n3"].text, "secret");
});

test("a client cannot claim authorship of another person's note", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n3": { id: "n3", text: "secret", hidden: true } }, bob);
  // Alice re-sends it claiming she wrote it, which would hand her the text.
  applyPatch(doc, { "note:b1:n3": { id: "n3", text: "secret", hidden: true, by: "alice" } }, alice);
  assert.equal(doc.entities["note:b1:n3"].by, "bob", "authorship is set once, by the server");
  assert.equal(snapshotFor(doc, "alice")["note:b1:n3"].text, "");
});

test("inbound entities are sanitised, not trusted", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:n4": { id: "spoofed", x: "12", color: "chartreuse", text: "x", rogue: true } }, alice);
  const n = doc.entities["note:b1:n4"];
  assert.equal(n.id, "n4", "the id comes from the key, not the body");
  assert.equal(n.x, 12);
  assert.equal(n.color, "yellow");
  assert.ok(!("rogue" in n));
});

test("malformed keys are refused", () => {
  for (const key of ["", "note", "note:b1", "../../etc/passwd", "note:b1:n1:extra", "note::n1"]) {
    assert.equal(parseKey(key), null, `${key} should not parse`);
  }
});

test("links to notes that have gone are dropped on rebuild", () => {
  const s = fromEntities({
    "board:b1": { id: "b1", name: "B", order: 0 },
    "note:b1:n1": { id: "n1", z: 1 },
    "link:b1:l1": { id: "l1", from: "n1", to: "gone" },
  });
  assert.equal(s.boards[0].links.length, 0);
});

test("a diff reports changes and removals and stays quiet otherwise", () => {
  const prev = { a: { x: 1 }, b: { y: 2 } };
  const next = { a: { x: 1 }, b: { y: 3 }, c: { z: 4 } };
  assert.deepEqual({ ...diffEntities(prev, next) }, { b: { y: 3 }, c: { z: 4 } });
  assert.deepEqual({ ...diffEntities(prev, { a: { x: 1 } }) }, { b: null });
  assert.deepEqual({ ...diffEntities(prev, prev) }, {});
});

test("key order does not make an unchanged entity look changed", () => {
  assert.deepEqual({ ...diffEntities({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }) }, {});
});

test("a participant may cast their own ballot but not change how the vote runs", () => {
  const doc = doc0();
  applyPatch(doc, {
    "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [] },
  }, alice);

  // Bob votes. His ballot lands.
  applyPatch(doc, {
    "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [{ by: "bob", dots: { n1: 2 } }] },
  }, bob);
  assert.deepEqual(doc.entities["vote:b1"].voters, [{ by: "bob", dots: { n1: 2 } }]);

  // Bob tries to close the vote and hand himself more dots, riding along with a ballot change.
  applyPatch(doc, {
    "vote:b1": { status: "closed", type: "thumbs", startedAt: "hacked", dotsPerVoter: 20, voters: [{ by: "bob", dots: { n1: 3 } }] },
  }, bob);
  const v = doc.entities["vote:b1"];
  assert.equal(v.status, "active", "a participant must not close the vote");
  assert.equal(v.type, "dots");
  assert.equal(v.dotsPerVoter, 3, "nor help themselves to more dots");
  assert.equal(v.startedAt, "t0");
  assert.deepEqual(v.voters, [{ by: "bob", dots: { n1: 3 } }], "but their own ballot still updates");
});

test("a participant cannot overwrite somebody else's ballot", () => {
  const doc = doc0();
  applyPatch(doc, { "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [] } }, alice);
  applyPatch(doc, { "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [{ by: "carol", dots: { n1: 1 } }] } }, { by: "carol" });
  applyPatch(doc, {
    "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [{ by: "carol", dots: { n1: 99 } }, { by: "bob", dots: { n2: 1 } }] },
  }, bob);
  const byWho = Object.fromEntries(doc.entities["vote:b1"].voters.map(v => [v.by, v.dots]));
  assert.deepEqual(byWho.carol, { n1: 1 }, "Carol's ballot is untouched");
  assert.deepEqual(byWho.bob, { n2: 1 });
});

test("a participant cannot cancel a vote", () => {
  const doc = doc0();
  applyPatch(doc, { "vote:b1": { status: "active", type: "dots", startedAt: "t0", dotsPerVoter: 3, voters: [] } }, alice);
  const r = applyPatch(doc, { "vote:b1": null }, bob);
  assert.equal(r.rejected[0][1], "not-facilitator");
  assert.ok(doc.entities["vote:b1"], "the vote is still running");
});

test("a participant cannot open a vote that was never started", () => {
  const doc = doc0();
  const r = applyPatch(doc, { "vote:b1": { status: "active", type: "dots", startedAt: "", dotsPerVoter: 3, voters: [] } }, bob);
  assert.equal(r.rejected[0][1], "not-facilitator");
  assert.ok(!("vote:b1" in doc.entities));
});

test("moving somebody's face-down note does not destroy its text", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:s1": { id: "s1", text: "my private idea", hidden: true } }, bob);

  // Alice only ever received a blank copy, and now drags it across the board.
  const asAlice = { ...snapshotFor(doc, "alice")["note:b1:s1"], x: 400 };
  assert.equal(asAlice.text, "", "this is what Alice's screen actually holds");
  applyPatch(doc, { "note:b1:s1": asAlice }, alice);

  assert.equal(doc.entities["note:b1:s1"].text, "my private idea", "the words must survive");
  assert.equal(doc.entities["note:b1:s1"].x, 400, "but the move still applies");
  assert.equal(snapshotFor(doc, "bob")["note:b1:s1"].text, "my private idea");
});

test("revealing a brainstorm does not blank the notes the facilitator could not see", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:s1": { id: "s1", text: "sofie's idea", hidden: true } }, bob);

  // Alice reveals: her client patches every note from a screen where they all read as empty.
  const seen = { ...snapshotFor(doc, "alice")["note:b1:s1"] };
  delete seen.hidden;
  applyPatch(doc, { "note:b1:s1": seen }, alice);

  assert.equal(doc.entities["note:b1:s1"].text, "sofie's idea");
  assert.ok(!doc.entities["note:b1:s1"].hidden, "and it really is revealed");
  assert.equal(snapshotFor(doc, "alice")["note:b1:s1"].text, "sofie's idea", "now everyone can read it");
});

test("an author can still edit their own face-down note", () => {
  const doc = doc0();
  applyPatch(doc, { "note:b1:s1": { id: "s1", text: "first thought", hidden: true } }, bob);
  applyPatch(doc, { "note:b1:s1": { id: "s1", text: "better thought", hidden: true } }, bob);
  assert.equal(doc.entities["note:b1:s1"].text, "better thought");
});
