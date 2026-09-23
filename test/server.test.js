// End-to-end over a real socket: create a room, join it twice, and check that what one person
// does reaches the other — and that what should stay private does not.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

process.env.SB_DATA_DIR = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sb-test-"));
process.env.SB_ROOMS_PER_HOUR = "100000";   // the suite makes far more boards than a person would
const { server, rooms } = require("../server/index.js");

const SAMPLE = {
  format: "sticky-board", version: 2, project: "Test", snap: true,
  legend: {}, linkDefaults: {}, parking: [], activeBoard: "b1",
  boards: [{ id: "b1", name: "Current", notes: [], frames: [], links: [], vote: null, brainstorm: null }],
};

let base;
test.before(() => new Promise(res => server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${server.address().port}`;
  res();
})));
test.after(() => { server.close(); for (const ws of require("../server/index.js").wss.clients) ws.terminate(); });

async function createRoom() {
  const r = await fetch(`${base}/api/rooms`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SAMPLE),
  });
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

/** A tiny client that queues messages so a test can await the next one of a kind. */
function connect(roomId, name) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?room=${roomId}`);
  const queue = [];
  const waiters = [];
  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex(w => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const next = type => {
    const i = queue.findIndex(m => m.type === type);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { type, resolve };
      waiters.push(w);
      setTimeout(() => { if (waiters.includes(w)) reject(new Error(`timed out waiting for ${type}`)); }, 3000);
    });
  };
  const sendRaw = o => ws.send(JSON.stringify(o));
  const open = new Promise(res => ws.on("open", res));
  return {
    ws, next, send: sendRaw,
    async hello() { await open; sendRaw({ type: "hello", name }); return next("welcome"); },
    close() { ws.close(); },
  };
}

const note = (id, over = {}) => ({ id, x: 0, y: 0, w: 120, h: 124, color: "yellow", text: "", z: 1, ...over });

test("a board link is rejected when it names no real room", async () => {
  const c = connect("a".repeat(32), "Nobody");
  await new Promise(r => c.ws.on("open", r));
  c.send({ type: "hello", name: "Nobody" });
  const err = await c.next("error");
  assert.equal(err.code, "no-room");
  c.close();
});

test("a malformed board link is rejected outright", async () => {
  const r = await fetch(`${base}/b/not-a-room`);
  assert.equal(r.status, 404);
});

test("the first person in a room runs it, the second does not", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const wa = await a.hello();
  assert.equal(wa.role, "facilitator");
  const b = connect(id, "Sofie");
  const wb = await b.hello();
  assert.equal(wb.role, "participant");
  const peers = await a.next("peers");
  assert.deepEqual(peers.peers.map(p => p.name).sort(), ["Angelo", "Sofie"]);
  a.close(); b.close();
});

test("a note added by one person arrives at the other", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const b = connect(id, "Sofie");
  await a.hello();
  await b.hello();
  a.send({ type: "patch", entities: { "note:b1:n1": note("n1", { text: "hello room" }) } });
  const p = await b.next("patch");
  assert.equal(p.entities["note:b1:n1"].text, "hello room");
  a.close(); b.close();
});

test("a deletion travels as a deletion", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const b = connect(id, "Sofie");
  await a.hello(); await b.hello();
  a.send({ type: "patch", entities: { "note:b1:n1": note("n1") } });
  await b.next("patch");
  a.send({ type: "patch", entities: { "note:b1:n1": null } });
  const p = await b.next("patch");
  assert.equal(p.entities["note:b1:n1"], null);
  a.close(); b.close();
});

test("a face-down note never reaches anyone but its author", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const b = connect(id, "Sofie");
  await a.hello(); await b.hello();
  b.send({ type: "patch", entities: { "note:b1:secret": note("secret", { text: "my idea", hidden: true }) } });
  const p = await a.next("patch");
  assert.equal(p.entities["note:b1:secret"].text, "", "the text must not be on the wire at all");
  assert.equal(p.entities["note:b1:secret"].hidden, true);
  a.close(); b.close();
});

test("a participant cannot start a vote", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const b = connect(id, "Sofie");
  await a.hello(); await b.hello();
  b.send({ type: "patch", entities: { "vote:b1": { status: "active", type: "dots", dotsPerVoter: 3, voters: [] } } });
  // Nothing should reach the facilitator; prove it by sending a legitimate patch behind it and
  // checking that is the first thing to arrive.
  b.send({ type: "patch", entities: { "note:b1:n9": note("n9", { text: "after" }) } });
  const p = await a.next("patch");
  assert.deepEqual(Object.keys(p.entities), ["note:b1:n9"]);
  a.close(); b.close();
});

test("a rejoin asks for only what it missed", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const w = await a.hello();
  a.send({ type: "patch", entities: { "note:b1:n1": note("n1", { text: "one" }) } });
  const ack = await a.next("ack");

  const again = connect(id, "Angelo again");
  await new Promise(r => again.ws.on("open", r));
  again.send({ type: "hello", name: "Angelo again", since: ack.seq });
  const w2 = await again.next("welcome");
  assert.equal(w2.full, false, "a resumable client gets a delta, not the whole board");
  assert.deepEqual(Object.keys(w2.entities), []);

  const fresh = connect(id, "Tom");
  const w3 = await fresh.hello();
  assert.equal(w3.full, true);
  assert.ok(w3.entities["note:b1:n1"], "a new joiner gets the whole board");
  a.close(); again.close(); fresh.close();
  assert.ok(w.seq >= 0);
});

test("the room keeps running when the facilitator leaves", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  const b = connect(id, "Sofie");
  await a.hello();
  const wb = await b.hello();
  await a.next("peers");
  a.close();
  const peers = await b.next("peers");
  assert.equal(peers.peers.length, 1);
  assert.equal(peers.peers[0].facilitator, true, "the last one standing takes over");
  assert.equal(peers.peers[0].id, wb.you.id);
  b.close();
});

test("a board survives being written out and read back", async () => {
  const id = await createRoom();
  const a = connect(id, "Angelo");
  await a.hello();
  a.send({ type: "patch", entities: { "note:b1:n1": note("n1", { text: "persist me" }) } });
  await a.next("ack");
  a.close();
  const room = await rooms.get(id);
  await rooms.flush(room);
  rooms.rooms.delete(id);
  const reloaded = await rooms.get(id);
  assert.equal(reloaded.doc.entities["note:b1:n1"].text, "persist me");
});

test("a cold room opened by several people at once loads exactly once", async () => {
  const id = await createRoom();
  const room = await rooms.get(id);
  await rooms.flush(room);
  rooms.rooms.delete(id);           // as if the room had gone idle and left memory

  // Everybody clicks the link at the same moment.
  const loaded = await Promise.all([rooms.get(id), rooms.get(id), rooms.get(id), rooms.get(id)]);
  const first = loaded[0];
  assert.ok(first, "the room should load");
  for (const r of loaded) assert.equal(r, first, "everyone must get the same room object");
  assert.equal(rooms.rooms.get(id), first, "and it must be the one in the registry");

  // A patch through one of them is visible through all of them — they are not separate documents.
  applyPatchThrough(loaded[3], "note:b1:zz", { id: "zz", text: "shared" });
  assert.equal(first.doc.entities["note:b1:zz"].text, "shared");
});

function applyPatchThrough(room, key, value) {
  const { applyPatch } = require("../server/merge.js");
  applyPatch(room.doc, { [key]: value }, { by: "someone", facilitator: true });
}
