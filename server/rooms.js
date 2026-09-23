// Sticky Board — rooms: who is in one, who runs it, and how it survives a restart.
//
// A room id is the credential. There are no accounts: anyone holding the link is in, which is what
// makes sharing a board as quick as pasting a URL into a meeting chat. That only works if ids are
// unguessable and never enumerable, hence 160 bits of randomness and no "list rooms" route.
//
// A room is persisted as an ordinary board document, so server/data/<id>.json can be opened in the
// app like any other project file if something ever needs recovering by hand.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { createDoc, docToState, pruneTombs } = require("./merge");
const { toEntities, fromEntities } = require("./entities");
const { validateEntity } = require("./validate");

const ID_RE = /^[a-z2-7]{32}$/;                 // base32, 160 bits
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

const DEFAULTS = {
  dir: process.env.SB_DATA_DIR || path.join(__dirname, "data"),
  maxRooms: 500,
  maxPeers: 40,
  idleMs: 30 * 60 * 1000,       // drop an empty room from memory after half an hour
  saveDebounceMs: 2000,
};

// 20 random bytes is 160 bits, which is exactly 32 base32 characters — no padding, no waste.
function newRoomId() {
  const bytes = crypto.randomBytes(20);
  let out = "", acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}

const PEER_COLOURS = ["#2F6FB0", "#C0392B", "#3E8E41", "#D9822B", "#7B5EA7", "#0E8A8A", "#B03A6E", "#5B7A1F"];

class Rooms {
  constructor(opts = {}) {
    this.opt = { ...DEFAULTS, ...opts };
    this.rooms = new Map();
    // Two people opening the same link at once would otherwise both read it off disk and both
    // install a room object; the second wins the map and the first set of peers carry on
    // patching a document nobody can see any more. One load per room, shared.
    this.loading = new Map();
    fs.mkdirSync(this.opt.dir, { recursive: true });
    // `maxRooms` has to count what is on disk too: an idle room leaves its file behind when it
    // drops out of memory, so counting only live rooms caps nothing.
    try { this.onDisk = fs.readdirSync(this.opt.dir).filter(f => f.endsWith(".json")).length; }
    catch { this.onDisk = 0; }
  }

  file(id) { return path.join(this.opt.dir, `${id}.json`); }

  /** Create a room seeded with a document the creator already has open. */
  async create(state) {
    if (this.rooms.size >= this.opt.maxRooms || this.onDisk >= this.opt.maxRooms) throw new Error("too-many-rooms");
    const id = newRoomId();
    // The document arrives over HTTP from whoever asked for the room, so it gets the same
    // treatment as any other inbound data: split into entities, every one validated, then put
    // back together. Anything that fails is dropped rather than carried into the room.
    const raw = toEntities(state);
    const clean = Object.create(null);
    for (const key of Object.keys(raw)) {
      const e = validateEntity(key, raw[key]);
      if (e) clean[key] = e;
    }
    const room = this.blank(id, fromEntities(clean));
    this.rooms.set(id, room);
    await this.persist(room);
    this.onDisk++;
    return room;
  }

  blank(id, state) {
    return {
      id,
      doc: createDoc(state),
      peers: new Map(),
      seat: 0,                 // monotonic, so the longest-connected peer is easy to find
      dirty: false,
      saveTimer: null,
      idleTimer: null,
      lastActive: Date.now(),
    };
  }

  /** Fetch a room, loading it from disk on first use. Null when there is no such room. */
  async get(id) {
    if (!ID_RE.test(id)) return null;
    const live = this.rooms.get(id);
    if (live) { this.touch(live); return live; }
    const inFlight = this.loading.get(id);
    if (inFlight) return inFlight;
    const p = this.load(id).finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  async load(id) {
    let raw;
    try { raw = await fsp.readFile(this.file(id), "utf8"); }
    catch { return null; }
    let saved;
    try { saved = JSON.parse(raw); } catch { return null; }
    if (!saved || !saved.state || !Array.isArray(saved.state.boards)) return null;
    // Somebody may have won the race while we were reading.
    const now = this.rooms.get(id);
    if (now) { this.touch(now); return now; }
    if (this.rooms.size >= this.opt.maxRooms) throw new Error("too-many-rooms");
    const room = this.blank(id, saved.state);
    this.rooms.set(id, room);
    this.touch(room);
    return room;
  }

  // ---------- peers ----------

  join(room, { name, socket }) {
    if (room.peers.size >= this.opt.maxPeers) throw new Error("room-full");
    const id = crypto.randomBytes(8).toString("hex");
    const peer = {
      id,
      name: String(name || "").trim().slice(0, 40) || "Guest",
      colour: PEER_COLOURS[room.seat % PEER_COLOURS.length],
      socket,
      seat: room.seat++,
      // The first person in the room runs it; see promote() for what happens when they leave.
      facilitator: room.peers.size === 0,
      cursor: null,
    };
    room.peers.set(id, peer);
    this.touch(room);
    return peer;
  }

  leave(room, peerId) {
    const peer = room.peers.get(peerId);
    if (!peer) return null;
    room.peers.delete(peerId);
    const promoted = peer.facilitator ? this.promote(room) : null;
    if (!room.peers.size) this.flush(room);
    this.touch(room);
    return promoted;
  }

  /** A room without a facilitator cannot run a vote, so the longest-connected peer takes over. */
  promote(room) {
    let next = null;
    for (const p of room.peers.values()) if (!next || p.seat < next.seat) next = p;
    if (next) next.facilitator = true;
    return next;
  }

  /** Hand the role over deliberately. Returns false if the target has gone. */
  handOver(room, fromId, toId) {
    const from = room.peers.get(fromId), to = room.peers.get(toId);
    if (!from || !from.facilitator || !to) return false;
    from.facilitator = false;
    to.facilitator = true;
    return true;
  }

  roster(room) {
    return [...room.peers.values()].map(p => ({ id: p.id, name: p.name, colour: p.colour, facilitator: p.facilitator }));
  }

  // ---------- persistence ----------

  touch(room) {
    room.lastActive = Date.now();
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => this.evict(room), this.opt.idleMs);
    room.idleTimer.unref?.();
  }

  /** Mark the room changed; the write itself is debounced so a busy board is not thrashing the disk. */
  dirty(room) {
    room.dirty = true;
    this.touch(room);
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => { room.saveTimer = null; this.flush(room); }, this.opt.saveDebounceMs);
    room.saveTimer.unref?.();
  }

  flush(room) {
    if (!room.dirty) return Promise.resolve();
    room.dirty = false;
    // Nobody can ask for changes older than the least-caught-up peer, so older tombstones are dead weight.
    let lowest = room.doc.seq;
    for (const p of room.peers.values()) lowest = Math.min(lowest, p.seq ?? room.doc.seq);
    pruneTombs(room.doc, Math.max(0, lowest - 1));
    return this.persist(room).catch(err => {
      room.dirty = true;   // keep it queued; a full disk should not silently lose the board
      console.error(`[rooms] could not save ${room.id}: ${err.message}`);
    });
  }

  async persist(room) {
    const body = JSON.stringify({
      v: 1,
      seq: room.doc.seq,
      savedAt: new Date().toISOString(),
      state: docToState(room.doc),
    }, null, 2);
    const target = this.file(room.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, target);      // atomic: a crash mid-write never truncates a live board
  }

  evict(room) {
    if (room.peers.size) return this.touch(room);
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
    this.flush(room).finally(() => {
      if (!room.peers.size) this.rooms.delete(room.id);
    });
  }

  /** Write every room still held in memory — called on shutdown. */
  async flushAll() {
    await Promise.allSettled([...this.rooms.values()].map(r => {
      clearTimeout(r.saveTimer);
      r.saveTimer = null;
      return this.flush(r);
    }));
  }
}

module.exports = { Rooms, ID_RE, newRoomId, PEER_COLOURS };
