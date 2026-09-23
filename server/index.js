// Sticky Board — collaboration server.
//
// One process, one port: it serves the board page and the WebSocket that keeps copies of it in
// step. That is the whole deployment story — run it on a VPS behind TLS, or on the facilitator's
// laptop so the room joins over the office wifi.
//
//   npm run serve                  http://localhost:8080
//   PORT=80 HOST=0.0.0.0 npm run serve
//
// Protocol, client -> server
//   hello    {name, since}                 first message; `since` asks for a delta after a drop
//   patch    {entities:{key:value|null}}   only entities this client actually changed
//   cursor   {x, y, board, sel}            ephemeral, never stored, never in a save file
//   name     {name}
//   present  {on, board}                   facilitator only
//   handover {to}                          facilitator only
//
// Protocol, server -> client
//   welcome  {you, role, peers, state|delta, seq}
//   patch    {from, entities, seq}
//   peers    {peers}
//   cursor   {from, x, y, board, sel}
//   present  {on, board, by}
//   error    {code, message}

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const { Rooms, ID_RE } = require("./rooms");
const { applyPatch, deltaSince, snapshotFor, redactFor } = require("./merge");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(__dirname, "public");
const MAX_MESSAGE = 1024 * 1024;          // a whole large board still fits comfortably
const MAX_BODY = 8 * 1024 * 1024;

// Origins allowed to open a socket. Same-origin is always fine; set SB_ALLOWED_ORIGINS
// (comma separated) when the page is served from somewhere else.
const EXTRA_ORIGINS = String(process.env.SB_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const rooms = new Rooms();

// Room creation is the one thing an unauthenticated caller can do that costs disk, so it gets an
// allowance per address — generous enough that a busy facilitator never notices, low enough that a
// script cannot fill the disk. Everything else needs a room id somebody already handed out.
const ROOMS_PER_HOUR = Math.max(1, Number(process.env.SB_ROOMS_PER_HOUR) || 60);
const createBuckets = new Map();
function mayCreate(req) {
  const who = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const now = Date.now();
  let b = createBuckets.get(who);
  if (!b) { b = { tokens: ROOMS_PER_HOUR, last: now }; createBuckets.set(who, b); }
  b.tokens = Math.min(ROOMS_PER_HOUR, b.tokens + ((now - b.last) / 3600000) * ROOMS_PER_HOUR);
  b.last = now;
  if (createBuckets.size > 5000) for (const [k, v] of createBuckets) { if (now - v.last > 3600000) createBuckets.delete(k); }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ---------- static files ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

/** Serve a file from `base`, refusing anything that resolves outside it. */
async function sendFile(res, base, rel, { immutable = false } = {}) {
  const target = path.resolve(base, "." + path.posix.resolve("/", rel));
  if (target !== base && !target.startsWith(base + path.sep)) return send(res, 403, "Forbidden");
  let body;
  try { body = await fsp.readFile(target); }
  catch { return send(res, 404, "Not found"); }
  send(res, 200, body, {
    "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too-large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return send(res, 400, "Bad request"); }
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/rooms") {
    if (!sameOrigin(req)) return send(res, 403, "Forbidden");
    if (!mayCreate(req)) return send(res, 429, "Too many boards created from here. Try again later.");
    let state;
    try { state = JSON.parse(await readBody(req)); }
    catch { return send(res, 400, "Send the board as JSON."); }
    if (!state || !Array.isArray(state.boards) || !state.boards.length) {
      return send(res, 400, "That isn't a Sticky Board project.");
    }
    let room;
    try { room = await rooms.create(state); }
    catch (err) {
      const full = err.message === "too-many-rooms";
      if (!full) console.error(`[serve] could not create a room: ${err.stack || err.message}`);
      return send(res, full ? 503 : 500, full ? "This server is at capacity. Try again later." : "The room couldn't be created.");
    }
    return send(res, 200, JSON.stringify({ id: room.id, path: `/b/${room.id}` }), { "Content-Type": TYPES[".json"] });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

  // A room link and the bare page are the same document; the page reads the id out of the URL.
  if (p === "/" || /^\/b\/[a-z2-7]{32}$/.test(p)) return sendFile(res, PUBLIC, "index.html");
  if (p.startsWith("/b/")) return send(res, 404, "That board link isn't valid.");

  // Fonts ship in node_modules; serving them from there keeps the generated page free of binaries.
  if (p.startsWith("/fonts/")) {
    return sendFile(res, path.join(ROOT, "node_modules", "@fontsource"), p.slice("/fonts/".length), { immutable: true });
  }

  if (p === "/healthz") return send(res, 200, "ok");

  return sendFile(res, PUBLIC, p);
});

/** The room link is the only credential, so a socket must come from a page we served. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                     // native clients (the desktop app) send none
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

server.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return socket.destroy(); }
  if (url.pathname !== "/ws" || !sameOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, url));
});

const tell = (ws, type, body) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...body }));
};
const fail = (ws, code, message) => { tell(ws, "error", { code, message }); ws.close(1008, code); };

/** A simple token bucket — enough to stop one tab flooding a room. */
function bucket(perSecond, burst) {
  let tokens = burst, last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

wss.on("connection", async (ws, req, url) => {
  const roomId = url.searchParams.get("room") || "";
  if (!ID_RE.test(roomId)) return fail(ws, "bad-room", "That board link isn't valid.");

  // The listener goes on before anything is awaited. `ws` starts delivering frames the moment the
  // connection exists, and a client says hello immediately — read the room off disk first and that
  // hello lands on an emitter nobody is listening to, leaving the page on "Connecting…" for ever
  // with a socket that is perfectly healthy.
  const early = [];
  let deliver = msg => early.push(msg);
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    deliver(msg);
  });

  let room;
  try { room = await rooms.get(roomId); }
  catch { return fail(ws, "busy", "This server is at capacity. Try again later."); }
  if (!room) return fail(ws, "no-room", "That board no longer exists.");

  let peer = null;
  const patchLimit = bucket(60, 120);
  const cursorLimit = bucket(30, 60);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const others = () => [...room.peers.values()].filter(p => p !== peer);
  // The roster ships inside `welcome`, so a joiner is told about itself once, not twice.
  const broadcastPeers = ({ skipSelf = false } = {}) => {
    const peers = rooms.roster(room);
    for (const p of skipSelf ? others() : room.peers.values()) tell(p.socket, "peers", { peers });
  };

  function onMessage(msg) {
    if (!peer) {
      if (msg.type !== "hello") return fail(ws, "protocol", "Say hello first.");
      try { peer = rooms.join(room, { name: msg.name, socket: ws }); }
      catch { return fail(ws, "room-full", "This board already has as many people as it can hold."); }

      const delta = Number.isFinite(msg.since) ? deltaSince(room.doc, msg.since, peer.id) : null;
      peer.seq = room.doc.seq;
      tell(ws, "welcome", {
        you: { id: peer.id, name: peer.name, colour: peer.colour },
        role: peer.facilitator ? "facilitator" : "participant",
        peers: rooms.roster(room),
        // A delta when we can resume, the whole board when we cannot.
        entities: delta || snapshotFor(room.doc, peer.id),
        full: !delta,
        seq: room.doc.seq,
      });
      broadcastPeers({ skipSelf: true });
      return;
    }

    switch (msg.type) {
      case "patch": {
        if (!patchLimit()) return;
        if (!msg.entities || typeof msg.entities !== "object") return;
        const { applied } = applyPatch(room.doc, msg.entities, { by: peer.id, facilitator: peer.facilitator });
        if (!Object.keys(applied).length) return;
        peer.seq = room.doc.seq;
        // Everyone gets the change, but a face-down note reaches only the person who wrote it.
        for (const p of room.peers.values()) {
          if (p === peer) continue;
          tell(p.socket, "patch", { from: peer.id, entities: redactFor(applied, p.id), seq: room.doc.seq });
          p.seq = room.doc.seq;
        }
        tell(ws, "ack", { seq: room.doc.seq });
        rooms.dirty(room);
        break;
      }

      case "cursor": {
        if (!cursorLimit()) return;
        const body = {
          from: peer.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          board: typeof msg.board === "string" ? msg.board.slice(0, 64) : "",
          sel: typeof msg.sel === "string" ? msg.sel.slice(0, 64) : "",
        };
        for (const p of others()) tell(p.socket, "cursor", body);
        break;
      }

      case "name": {
        peer.name = String(msg.name || "").trim().slice(0, 40) || "Guest";
        broadcastPeers();
        break;
      }

      case "present": {
        if (!peer.facilitator) return;
        const body = { on: !!msg.on, board: typeof msg.board === "string" ? msg.board.slice(0, 64) : "", by: peer.id };
        for (const p of others()) tell(p.socket, "present", body);
        break;
      }

      case "handover": {
        if (rooms.handOver(room, peer.id, String(msg.to || ""))) broadcastPeers();
        break;
      }

      default: break;
    }
  }

  deliver = onMessage;
  early.splice(0).forEach(onMessage);

  const bye = () => {
    if (!peer) return;
    rooms.leave(room, peer.id);
    peer = null;
    broadcastPeers();
  };
  ws.on("close", bye);
  ws.on("error", bye);
});

// Drop sockets that have stopped answering, so a closed laptop lid does not linger in the roster.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

// ---------- lifecycle ----------

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[serve] ${signal} — saving rooms`);
  server.close();
  for (const ws of wss.clients) ws.close(1001, "server-restart");
  await rooms.flushAll();
  process.exit(0);
}
// Only take the port when run as a program; the tests import this file and listen on their own.
if (require.main === module) {
  if (!fs.existsSync(path.join(PUBLIC, "index.html"))) {
    console.error('[serve] server/public/index.html is missing — run "npm run sync" first.');
    process.exit(1);
  }
  server.on("error", err => {
    if (err.code === "EADDRINUSE") {
      console.error(`[serve] Port ${PORT} is already being used by something else.`);
      console.error(`[serve] Pick another one:  PORT=8081 npm run serve`);
    } else if (err.code === "EACCES") {
      console.error(`[serve] Not allowed to use port ${PORT}. Ports below 1024 need sudo — try PORT=8080.`);
    } else {
      console.error(`[serve] The server couldn't start: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[serve] Sticky Board on http://localhost:${PORT}`);
    // The whole point is other people joining, so say what to give them.
    if (HOST === "0.0.0.0") {
      for (const [name, addrs] of Object.entries(require("node:os").networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === "IPv4" && !a.internal) console.log(`[serve] On this network:  http://${a.address}:${PORT}   (${name})`);
        }
      }
    }
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { server, wss, rooms, shutdown };
