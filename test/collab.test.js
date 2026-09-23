// Two real pages, one real server. The protocol tests in server.test.js speak the wire format
// directly; this one drives the actual app, so it covers the client's entity diffing and the
// surgical repaint that keeps a remote change from wiping out what you are doing.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sb-collab-"));
process.env.SB_ROOMS_PER_HOUR = "100000";   // the suite makes far more boards than a person would
const { JSDOM } = require("jsdom");
const { server, wss } = require("../server/index.js");

const SERVED = path.join(__dirname, "..", "server", "public", "index.html");
const html = fs.readFileSync(SERVED, "utf8");

let base;
test.before(() => new Promise(res => server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${server.address().port}`;
  res();
})));
test.after(() => server.close());

function openPage(url) {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
    beforeParse(win) {
      win.addEventListener("error", e => errors.push(String(e.error || e.message)));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      win.requestAnimationFrame = cb => win.setTimeout(() => cb(Date.now()), 0);
      win.HTMLElement.prototype.setPointerCapture = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
        arc() {}, save() {}, restore() {}, translate() {}, scale() {}, setTransform() {}, closePath() {},
        measureText: () => ({ width: 10 }), fillText() {},
      });
      win.document.elementFromPoint = () => null;
      Object.defineProperty(win.HTMLElement.prototype, "innerText", {
        get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
      });
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, what, ms = 5000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Open a room link and get through the "who are you?" card. */
async function join(roomId, name) {
  const page = openPage(`${base}/b/${roomId}`);
  const input = await until(() => page.doc.querySelector(".sharedim .sharebox input"), "the name card");
  input.value = name;
  [...page.doc.querySelectorAll(".sharedim .sharebox button")].find(b => b.textContent === "Join").click();
  await until(() => page.doc.getElementById("status").textContent.startsWith("Shared"), `${name} to connect`);
  return page;
}

const noteTexts = doc => [...doc.querySelectorAll("#notes .note .txt")].map(el => el.textContent);

async function makeRoom() {
  const r = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "sticky-board", version: 2, project: "Workshop", snap: true,
      legend: {}, linkDefaults: {}, parking: [], activeBoard: "b1",
      boards: [{ id: "b1", name: "Current", notes: [], frames: [], links: [], vote: null, brainstorm: null }],
    }),
  });
  return (await r.json()).id;
}

/** Add a note by pressing Enter on a colour stack, then type into it and commit. */
function addNote(page, colour, text) {
  const stack = page.doc.querySelector(`.stack[data-color="${colour}"]`);
  stack.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const editing = page.doc.querySelector("#notes .note.editing .txt");
  if (!editing) return null;
  editing.textContent = text;
  editing.dispatchEvent(new page.win.Event("blur"));
  return editing;
}

test("a note typed on one device shows up on the other", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");

  addNote(a, "yellow", "ship the thing");
  await until(() => noteTexts(b.doc).includes("ship the thing"), "the note to arrive");

  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  a.win.close(); b.win.close();
});

test("both people show up in the roster, and the first one runs the board", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");
  assert.equal(a.doc.querySelector("#peers .who.lead").title, "Angelo (you) · runs this board");
  assert.equal(b.doc.querySelectorAll("#peers .who.lead").length, 1);
  a.win.close(); b.win.close();
});

test("a participant is told the facilitator runs the vote", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => b.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  b.doc.getElementById("btnVote").click();
  await until(() => b.doc.querySelector(".toast"), "a toast");
  assert.match(b.doc.querySelector(".toast").textContent, /facilitator/i);
  assert.equal(b.doc.getElementById("votebar").hidden, true, "no vote should have started");

  a.doc.getElementById("btnVote").click();
  assert.equal(a.doc.getElementById("votebar").hidden, false, "the facilitator gets the vote setup");
  a.win.close(); b.win.close();
});

test("one person's edit does not disturb a note somebody else is typing in", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");

  addNote(a, "blue", "first");
  await until(() => noteTexts(b.doc).includes("first"), "the note to arrive");

  // Sofie starts typing into her own new note...
  const stack = b.doc.querySelector('.stack[data-color="green"]');
  stack.dispatchEvent(new b.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const mine = b.doc.querySelector("#notes .note.editing .txt");
  assert.ok(mine, "Sofie should be editing");
  mine.textContent = "half a thought";

  // ...while Angelo adds another note.
  addNote(a, "red", "meanwhile");
  await until(() => noteTexts(b.doc).includes("meanwhile"), "the second note to arrive");

  assert.equal(b.doc.querySelector("#notes .note.editing .txt").textContent, "half a thought",
    "the remote change must not have touched what Sofie is typing");
  a.win.close(); b.win.close();
});

test("undoing your own work leaves everyone else's alone", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");

  addNote(a, "yellow", "angelo one");
  await until(() => noteTexts(b.doc).includes("angelo one"), "Angelo's note on Sofie's screen");

  addNote(b, "green", "sofie one");
  await until(() => noteTexts(a.doc).includes("sofie one"), "Sofie's note on Angelo's screen");

  // Angelo undoes his own note. Sofie's must survive on both screens.
  a.doc.getElementById("btnUndo").click();
  await until(() => !noteTexts(b.doc).includes("angelo one"), "the undo to reach Sofie");

  assert.ok(noteTexts(a.doc).includes("sofie one"), "Angelo's undo wiped Sofie's note locally");
  assert.ok(noteTexts(b.doc).includes("sofie one"), "Angelo's undo wiped Sofie's note for her too");
  a.win.close(); b.win.close();
});

test("a face-down brainstorm note never reaches the other device", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  // Angelo (facilitator) starts a silent brainstorm.
  a.doc.getElementById("btnBrainstorm").click();
  const start = [...a.doc.querySelectorAll("#bsbar button")].find(x => x.textContent === "Start");
  start.click();
  await until(() => b.doc.getElementById("bsbar").hidden === false, "the brainstorm to reach Sofie");

  addNote(b, "yellow", "my private idea");
  await until(() => a.doc.querySelectorAll("#notes .note").length === 1, "the face-down note to arrive");

  const onAngelos = a.doc.querySelector("#notes .note");
  assert.ok(onAngelos.classList.contains("facedown"), "it should show as face-down");
  assert.equal(a.dom.serialize().includes("my private idea"), false,
    "the text must not be anywhere in the other person's page");

  a.win.close(); b.win.close();
});

test("a participant votes from their own device and the tally reaches everyone", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  addNote(a, "yellow", "option one");
  await until(() => noteTexts(b.doc).includes("option one"), "the note to reach Sofie");

  // Angelo, the facilitator, opens a dot vote.
  a.doc.getElementById("btnVote").click();
  [...a.doc.querySelectorAll("#votebar button")].find(x => x.textContent === "Start vote").click();
  await until(() => b.doc.getElementById("votebar").hidden === false, "the vote to reach Sofie");

  // Sofie places a dot by pressing on the note.
  const note = b.doc.querySelector("#notes .note");
  const opts = { bubbles: true, button: 0, pointerId: 1, clientX: 50, clientY: 50 };
  note.dispatchEvent(new b.win.PointerEvent("pointerdown", opts));
  note.dispatchEvent(new b.win.PointerEvent("pointerup", opts));

  await until(() => a.doc.querySelectorAll("#notes .note .dots b").length === 1,
    "Sofie's dot to show on Angelo's board");

  // And the room can see somebody has voted.
  await until(() => /1 in|1 of|1 person/.test(a.doc.getElementById("votebar").textContent),
    "the count of who has voted");

  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  a.win.close(); b.win.close();
});

test("a consensus check collects a number from each device", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  addNote(a, "yellow", "adopt the thing");
  await until(() => noteTexts(b.doc).includes("adopt the thing"), "the note to reach Sofie");

  // Angelo selects the note and starts a check from the toolbar menu path.
  const note = a.doc.querySelector("#notes .note");
  note.dispatchEvent(new a.win.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }));
  note.dispatchEvent(new a.win.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }));
  a.doc.getElementById("menuEdit").click();
  const item = [...a.doc.querySelectorAll(".menu button")].find(x => x.textContent.includes("Consensus check on selection"));
  assert.ok(item, "the Edit menu should offer a consensus check");
  item.click();

  const bar = await until(() => {
    const el = a.doc.getElementById("csbar");
    return !el.hidden && el.querySelector(".fist") ? el : null;
  }, "the consensus bar");

  // It reaches Sofie, who holds up a number of her own.
  await until(() => !b.doc.getElementById("csbar").hidden && b.doc.querySelector("#csbar .fist"), "the check to reach Sofie");
  [...b.doc.querySelectorAll("#csbar .fist button")].find(x => x.textContent === "4").click();
  await until(() => /1 in/.test(a.doc.getElementById("csbar").textContent), "Sofie's number to be counted");

  // Angelo adds his own, then shows the result to the room.
  [...bar.querySelectorAll(".fist button")].find(x => x.textContent === "5").click();
  await until(() => /2 in/.test(a.doc.getElementById("csbar").textContent), "both numbers in");

  [...a.doc.querySelectorAll("#csbar button")].find(x => x.textContent.startsWith("Show result")).click();
  await until(() => /Consensus|Weak support|Objections/.test(b.doc.getElementById("csbar").textContent),
    "the verdict to reach Sofie");

  assert.match(a.doc.getElementById("csbar").textContent, /2 voters/);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  a.win.close(); b.win.close();
});

test("a dropped connection comes back and catches up", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  // Pull the rug out from under Sofie only.
  const sofie = [...wss.clients].at(-1);
  sofie.terminate();
  await until(() => b.doc.getElementById("netbar").hidden === false, "the offline banner");
  assert.match(b.doc.getElementById("netbar").textContent, /Reconnecting/);

  // Angelo carries on working while she is away.
  addNote(a, "yellow", "added while she was away");

  // She comes back on her own and catches up without being told to refresh.
  await until(() => b.doc.getElementById("netbar").hidden === true, "the banner to clear", 12000);
  await until(() => noteTexts(b.doc).includes("added while she was away"), "the missed note", 12000);

  assert.deepEqual(b.errors, []);
  a.win.close(); b.win.close();
});

test("renaming the project reaches everyone and is not reverted", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  const name = a.doc.getElementById("projectName");
  name.value = "Quarterly retro";
  name.dispatchEvent(new a.win.Event("input", { bubbles: true }));
  name.dispatchEvent(new a.win.Event("change", { bubbles: true }));
  name.dispatchEvent(new a.win.Event("blur"));

  await until(() => b.doc.getElementById("projectName").value === "Quarterly retro", "the rename to reach Sofie");

  // Sofie does something unrelated; her patch must not push the old name back.
  addNote(b, "green", "unrelated");
  await until(() => noteTexts(a.doc).includes("unrelated"), "her note to reach Angelo");
  await sleep(250);
  assert.equal(a.doc.getElementById("projectName").value, "Quarterly retro", "the rename was reverted");
  assert.equal(b.doc.getElementById("projectName").value, "Quarterly retro");
  a.win.close(); b.win.close();
});

test("a parked note reaches the other person's parking lot and stays there", async () => {
  const id = await makeRoom();
  const a = await join(id, "Angelo");
  const b = await join(id, "Sofie");
  await until(() => a.doc.querySelectorAll("#peers .who").length === 2, "both peers");

  addNote(a, "yellow", "park me");
  await until(() => noteTexts(b.doc).includes("park me"), "the note to reach Sofie");

  // Angelo selects it and parks it from the Edit menu.
  const note = a.doc.querySelector("#notes .note");
  const press = { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 };
  note.dispatchEvent(new a.win.PointerEvent("pointerdown", press));
  note.dispatchEvent(new a.win.PointerEvent("pointerup", press));
  a.doc.getElementById("menuEdit").click();
  const item = [...a.doc.querySelectorAll(".menu button")].find(x => /park/i.test(x.textContent));
  assert.ok(item, "the Edit menu should offer parking");
  item.click();

  await until(() => !noteTexts(b.doc).includes("park me"), "it to leave Sofie's board");
  b.doc.getElementById("parkingBtn").click();
  await until(() => /park me/.test(b.doc.getElementById("actionsPanel").textContent),
    "it to appear in Sofie's parking lot");

  // Sofie does something else; her patch must not delete the parked note from the room.
  addNote(b, "blue", "something else");
  await until(() => noteTexts(a.doc).includes("something else"), "her note to reach Angelo");
  await sleep(250);
  assert.match(b.doc.getElementById("actionsPanel").textContent, /park me/, "the parked note was lost");
  a.win.close(); b.win.close();
});
