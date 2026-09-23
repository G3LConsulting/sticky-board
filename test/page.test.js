// Boot the real page in jsdom. The app is one long IIFE, so the thing most worth proving is that
// it still runs start to finish — a mistake in the collaboration section would otherwise only show
// up as a blank board in front of a room full of people.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const RENDERER = path.join(__dirname, "..", "renderer", "index.html");
const SERVED = path.join(__dirname, "..", "server", "public", "index.html");

/** Load a built page with the browser bits jsdom does not implement. */
function boot(file) {
  const html = fs.readFileSync(file, "utf8");
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost:8080/",
    beforeParse(win) {
      win.addEventListener("error", e => errors.push(e.error || e.message));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      win.requestAnimationFrame = cb => win.setTimeout(() => cb(Date.now()), 0);
      win.cancelAnimationFrame = id => win.clearTimeout(id);
      win.HTMLElement.prototype.setPointerCapture = () => {};
      win.HTMLElement.prototype.releasePointerCapture = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fill() {}, arc() {}, save() {}, restore() {}, translate() {}, scale() {},
        setTransform() {}, drawImage() {}, closePath() {}, rect() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, measureText: () => ({ width: 10 }), fillText() {},
      });
      win.document.elementFromPoint = () => null;
      Object.defineProperty(win.HTMLElement.prototype, "innerText", {
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
        configurable: true,
      });
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

const built = file => test.skip === undefined || fs.existsSync(file);

test("the desktop page boots without throwing", () => {
  assert.ok(fs.existsSync(RENDERER), 'run "npm run sync" first');
  const { win, doc, errors } = boot(RENDERER);
  assert.deepEqual(errors, [], "the page script threw while loading");
  assert.ok(doc.getElementById("wrap"), "the board never rendered");
  assert.ok(doc.querySelectorAll(".note").length > 0, "the sample project should put notes on the board");
  win.close();
});

test("sharing stays hidden where there is no server to share with", () => {
  const { win, doc } = boot(RENDERER);
  assert.equal(doc.getElementById("btnShare").hidden, true);
  assert.equal(doc.getElementById("peers").hidden, true);
  win.close();
});

test("the served page offers sharing", () => {
  assert.ok(fs.existsSync(SERVED), 'run "npm run sync" first');
  const { win, doc, errors } = boot(SERVED);
  assert.deepEqual(errors, [], "the page script threw while loading");
  assert.equal(doc.querySelector('meta[name="sb-collab"]').content, "1");
  assert.equal(doc.getElementById("btnShare").hidden, false, "the Share button belongs on the served page");
  win.close();
});

test("a board link asks who you are before joining", () => {
  const html = fs.readFileSync(SERVED, "utf8");
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost:8080/b/" + "a".repeat(32),
    beforeParse(win) {
      win.addEventListener("error", e => errors.push(e.error || e.message));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      win.requestAnimationFrame = cb => win.setTimeout(() => cb(Date.now()), 0);
      win.HTMLElement.prototype.setPointerCapture = () => {};
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
  assert.deepEqual(errors, [], "the page script threw while loading");
  const card = dom.window.document.querySelector(".sharedim .sharebox");
  assert.ok(card, "opening a /b/ link should ask for a name");
  assert.match(card.textContent, /Join this board/);
  dom.window.close();
});

test("editing a note still works on your own", () => {
  const { win, doc } = boot(RENDERER);
  const before = doc.querySelectorAll(".note").length;
  const stack = doc.querySelector('.stack[data-color="green"]');
  stack.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(doc.querySelectorAll(".note").length, before + 1, "pressing Enter on a stack adds a note");
  win.close();
});

test("undo puts a new note back", () => {
  const { win, doc } = boot(RENDERER);
  const before = doc.querySelectorAll(".note").length;
  doc.querySelector('.stack[data-color="red"]').dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(doc.querySelectorAll(".note").length, before + 1);
  doc.getElementById("btnUndo").click();
  assert.equal(doc.querySelectorAll(".note").length, before, "undo should remove it again");
  win.close();
});
