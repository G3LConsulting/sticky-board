// Sticky Board — Electron main process
// One window per project. The renderer (renderer/index.html) is the same app as the web version;
// it talks to this process through the small, explicit bridge in preload.js.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const WebSocket = require("ws");

const isMac = process.platform === "darwin";
const PROJECT_FILTER = [{ name: "Sticky Board project", extensions: ["json"] }];
const TEMPLATES = [
  { key: "retro", name: "Retrospective" },
  { key: "storm", name: "Event Storming" },
  { key: "swim", name: "Swimlane Process" },
  { key: "asis", name: "As-Is / To-Be Process" },
  { key: "matrix", name: "Priority Matrix" },
];
const THEMES = [
  { key: "system", name: "System" },
  { key: "light", name: "Light" },
  { key: "dark", name: "Dark" },
  { key: "easy", name: "Easy on the Eyes" },
];

/** webContents.id -> window state */
const windows = new Map();

// ---------- first-run flag (show the sample project once) ----------
const flagFile = () => path.join(app.getPath("userData"), "state.json");
function isFirstRun() {
  try { return !JSON.parse(fs.readFileSync(flagFile(), "utf8")).launched; } catch { return true; }
}
function markLaunched() {
  try { fs.mkdirSync(path.dirname(flagFile()), { recursive: true }); fs.writeFileSync(flagFile(), JSON.stringify({ launched: true })); } catch { /* not critical */ }
}

// ---------- windows ----------
function stateFor(sender) { return windows.get(sender.id); }
function focusedState() {
  const w = BrowserWindow.getFocusedWindow();
  return w ? windows.get(w.webContents.id) : null;
}
function windowForFile(filePath) {
  for (const st of windows.values()) if (st.filePath && path.resolve(st.filePath) === path.resolve(filePath)) return st;
  return null;
}

function createWindow({ filePath = null } = {}) {
  const prev = BrowserWindow.getFocusedWindow();
  const bounds = prev ? prev.getBounds() : null;
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 480,
    x: bounds ? bounds.x + 28 : undefined, y: bounds ? bounds.y + 28 : undefined,
    title: "Sticky Board",
    show: false,
    autoHideMenuBar: !isMac,            // Windows: the in-app File/Edit/View bar is visible; Alt shows the native one
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18191B" : "#EEEEEB",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  const id = win.webContents.id;
  const st = {
    win, id,
    filePath: null, pendingPath: null,
    dirty: false, project: "Untitled project",
    snap: true, groupMode: false, theme: "system", compare: false, side: "",
    sample: windows.size === 0 && !filePath && isFirstRun(),
    pendingClose: false, forceClose: false,
    roomSock: null,
  };
  windows.set(id, st);
  if (st.sample) markLaunched();

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.once("did-finish-load", () => { if (filePath) sendFile(st, filePath); });

  // The page sets document.title; the window title is managed here instead.
  win.on("page-title-updated", e => e.preventDefault());
  // Never navigate away from the app; open web links in the default browser.
  win.webContents.on("will-navigate", e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", e => onClose(e, st));
  win.on("closed", () => { closeRoom(st); windows.delete(id); buildMenu(); });
  win.on("focus", buildMenu);

  updateTitle(st);
  return st;
}

async function sendFile(st, filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    st.pendingPath = filePath;
    st.win.webContents.send("sb:open-file", { text, name: path.basename(filePath) });
  } catch (err) {
    dialog.showErrorBox("Couldn't open the project", `${path.basename(filePath)} couldn't be read.\n\n${err.message}`);
  }
}

function updateTitle(st) {
  const name = st.filePath ? path.basename(st.filePath).replace(/(\.board)?\.json$/i, "") : (st.project || "Untitled project");
  st.win.setTitle(`${name}${!isMac && st.dirty ? " •" : ""} — Sticky Board`);
  if (isMac) {
    st.win.setDocumentEdited(st.dirty);
    st.win.setRepresentedFilename(st.filePath || "");
  }
}

function onClose(e, st) {
  if (st.forceClose || !st.dirty) return;
  e.preventDefault();
  const response = dialog.showMessageBoxSync(st.win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0, cancelId: 2,
    message: `Do you want to save the changes to “${st.project || "Untitled project"}”?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  if (response === 0) { st.pendingClose = true; st.win.webContents.send("sb:command", "save-then-close"); }
  else if (response === 1) { st.forceClose = true; st.win.close(); }
}

// ---------- IPC ----------
ipcMain.on("sb:init", e => {
  const st = stateFor(e.sender);
  e.returnValue = { platform: process.platform, sample: !!st?.sample };
});

ipcMain.handle("sb:open", async (e, { reuse } = {}) => {
  const st = stateFor(e.sender); if (!st) return null;
  const r = await dialog.showOpenDialog(st.win, { filters: PROJECT_FILTER, properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const already = windowForFile(filePath);
  if (already) { already.win.show(); already.win.focus(); return null; }
  if (!reuse) { createWindow({ filePath }); return null; }
  const text = await fsp.readFile(filePath, "utf8");
  st.pendingPath = filePath;
  return { text, name: path.basename(filePath) };
});

// The renderer confirms whether the file it was handed was a valid project.
ipcMain.on("sb:opened", (e, ok) => {
  const st = stateFor(e.sender); if (!st) return;
  if (ok && st.pendingPath) { st.filePath = st.pendingPath; st.dirty = false; app.addRecentDocument(st.filePath); }
  st.pendingPath = null;
  updateTitle(st);
});

async function writeAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

ipcMain.handle("sb:save", async (e, { data, suggestedName, saveAs } = {}) => {
  const st = stateFor(e.sender); if (!st || typeof data !== "string") return null;
  let target = st.filePath;
  if (!target || saveAs) {
    const dir = st.filePath ? path.dirname(st.filePath) : app.getPath("documents");
    const r = await dialog.showSaveDialog(st.win, {
      defaultPath: path.join(dir, suggestedName || "project.board.json"),
      filters: PROJECT_FILTER,
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  try {
    await writeAtomic(target, data);
  } catch (err) {
    dialog.showErrorBox("Couldn't save the project", `${path.basename(target)} couldn't be written.\n\n${err.message}`);
    return null;
  }
  st.filePath = target; st.dirty = false;
  app.addRecentDocument(target);
  updateTitle(st);
  return { name: path.basename(target) };
});

ipcMain.handle("sb:export", async (e, { filename, data, ext, desc } = {}) => {
  const st = stateFor(e.sender); if (!st) return null;
  const extension = String(ext || "").replace(/^\./, "") || "txt";
  const dir = st.filePath ? path.dirname(st.filePath) : app.getPath("documents");
  const r = await dialog.showSaveDialog(st.win, {
    defaultPath: path.join(dir, filename || `export.${extension}`),
    filters: [{ name: desc || extension.toUpperCase(), extensions: [extension] }],
  });
  if (r.canceled || !r.filePath) return null;
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  try { await writeAtomic(r.filePath, buf); }
  catch (err) { dialog.showErrorBox("Couldn't export", `${path.basename(r.filePath)} couldn't be written.\n\n${err.message}`); return null; }
  return { name: path.basename(r.filePath) };
});

ipcMain.handle("sb:confirm-discard", async e => {
  const st = stateFor(e.sender); if (!st) return false;
  const { response } = await dialog.showMessageBox(st.win, {
    type: "warning", buttons: ["Discard Changes", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Start a new project in this window?",
    detail: "Your unsaved changes will be lost. Use File › New Window to keep this project open.",
  });
  return response === 0;
});

ipcMain.on("sb:state", (e, s = {}) => {
  const st = stateFor(e.sender); if (!st) return;
  st.dirty = !!s.dirty;
  st.project = String(s.project || "Untitled project");
  st.snap = !!s.snap; st.groupMode = !!s.groupMode;
  st.compare = !!s.compare; st.side = ["actions", "decisions", "parking"].includes(s.side) ? s.side : "";
  st.shared = !!s.shared;
  st.theme = THEMES.some(t => t.key === s.theme) ? s.theme : "system";
  updateTitle(st);
  if (BrowserWindow.getFocusedWindow() === st.win) buildMenu();
});

ipcMain.on("sb:close-after-save", (e, ok) => {
  const st = stateFor(e.sender); if (!st) return;
  if (ok && st.pendingClose) { st.forceClose = true; st.win.close(); }
  st.pendingClose = false;
});

// ---------- shared boards ----------
// The page has no network access of its own — its Content-Security-Policy allows nothing remote —
// so the connection to a board server is made here and relayed over IPC. That keeps the strict
// policy in renderer/index.html intact no matter which server someone joins.

/** Only ever talk to a plain http(s) origin the person typed in themselves. */
function cleanOrigin(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch { return null; }
}

function closeRoom(st) {
  if (!st || !st.roomSock) return;
  const sock = st.roomSock;
  st.roomSock = null;
  try { sock.close(); } catch { /* already gone */ }
}

ipcMain.handle("sb:room-create", async (e, { origin, state } = {}) => {
  const base = cleanOrigin(origin);
  if (!base) return { error: "That isn't a web address. It should start with http:// or https://." };
  try {
    const r = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { error: (await r.text()) || "The board couldn't be shared." };
    const { id } = await r.json();
    return { id };
  } catch {
    return { error: "That server couldn't be reached. Check the address and your connection." };
  }
});

ipcMain.on("sb:room-connect", (e, { origin, room, name, since } = {}) => {
  const st = stateFor(e.sender); if (!st) return;
  const base = cleanOrigin(origin);
  if (!base || !/^[a-z2-7]{32}$/.test(String(room || ""))) {
    st.win.webContents.send("sb:room-message", { type: "error", code: "bad-link", message: "That board link isn't valid." });
    return;
  }
  closeRoom(st);
  const url = `${base.replace(/^http/, "ws")}/ws?room=${encodeURIComponent(room)}`;
  let sock;
  try { sock = new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 15000 }); }
  catch {
    st.win.webContents.send("sb:room-status", "closed");
    return;
  }
  st.roomSock = sock;
  const alive = () => st.roomSock === sock && !st.win.isDestroyed();
  sock.on("open", () => { if (alive()) st.win.webContents.send("sb:room-status", "open"); });
  sock.on("message", raw => {
    if (!alive()) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    st.win.webContents.send("sb:room-message", msg);
  });
  sock.on("close", () => { if (alive()) { st.roomSock = null; st.win.webContents.send("sb:room-status", "closed"); } });
  sock.on("error", () => { try { sock.close(); } catch { /* already gone */ } });
  // The page asks for the roster itself once the socket is up; `name` and `since` ride along in
  // its own hello, so nothing about the document is decided here.
  void name; void since;
});

ipcMain.on("sb:room-send", (e, msg) => {
  const st = stateFor(e.sender);
  if (!st || !st.roomSock || st.roomSock.readyState !== WebSocket.OPEN) return;
  try { st.roomSock.send(JSON.stringify(msg)); } catch { /* the close handler will retry */ }
});

ipcMain.on("sb:room-close", e => closeRoom(stateFor(e.sender)));

// ---------- native menu ----------
function send(cmd) {
  const st = focusedState();
  if (st) st.win.webContents.send("sb:command", cmd);
}

let menuTimer = null;
function buildMenu() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenuNow, 30);
}
function buildMenuNow() {
  const st = focusedState();
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" }, { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        { label: "New Project in This Window", accelerator: "CmdOrCtrl+Shift+N", click: () => send("new-project") },
        {
          label: "New Project from Template",
          submenu: TEMPLATES.map(t => ({ label: `${t.name}`, click: () => send(`template-project:${t.key}`) })),
        },
        {
          label: "Add Board from Template",
          submenu: TEMPLATES.map(t => ({ label: `${t.name}`, click: () => send(`template-board:${t.key}`) })),
        },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => send("save-as") },
        { type: "separator" },
        ...(st && st.shared
          ? [
              { label: "Board Link…", click: () => send("share") },
              { label: "Leave Shared Board", click: () => send("leave") },
            ]
          : [
              { label: "Share Board…", click: () => send("share") },
              { label: "Join Board…", click: () => send("join") },
            ]),
        { type: "separator" },
        {
          label: "Export",
          submenu: [
            { label: "PNG Image (This Board)…", click: () => send("export-png") },
            { label: "SVG Image (This Board)…", click: () => send("export-svg") },
            { type: "separator" },
            { label: "Markdown (All Boards)…", click: () => send("export-md") },
            { label: "Copy Markdown", click: () => send("copy-md") },
          ],
        },
        { type: "separator" },
        { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ...(isMac ? [] : [{ role: "quit", label: "Exit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "Redo", accelerator: isMac ? "Shift+Cmd+Z" : "Ctrl+Y", click: () => send("redo") },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { label: "Duplicate", accelerator: "CmdOrCtrl+D", click: () => send("duplicate") },
        { label: "Group into Frame", accelerator: "CmdOrCtrl+G", click: () => send("group") },
        { label: "Delete", accelerator: isMac ? "Backspace" : "Delete", registerAccelerator: false, click: () => send("delete") },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => send("select-all") },
        { label: "Park Selection", click: () => send("park") },
        { type: "separator" },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: () => send("find") },
        { label: "Filter by Tag", click: () => send("filter-tags") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "Plus", registerAccelerator: false, click: () => send("zoom-in") },
        { label: "Zoom Out", accelerator: "-", registerAccelerator: false, click: () => send("zoom-out") },
        { label: "Fit Everything", accelerator: "0", registerAccelerator: false, click: () => send("fit") },
        { label: "Actual Size", click: () => send("actual-size") },
        { type: "separator" },
        { label: "Compare Boards", type: "checkbox", checked: st ? st.compare : false, click: () => send("compare") },
        { label: "Actions", type: "checkbox", checked: st?.side === "actions", click: () => send("actions") },
        { label: "Decisions", type: "checkbox", checked: st?.side === "decisions", click: () => send("decisions") },
        { label: "Parking Lot", type: "checkbox", checked: st?.side === "parking", click: () => send("parking") },
        { type: "separator" },
        { label: "Snap to Grid", type: "checkbox", checked: st ? st.snap : true, click: () => send("snap") },
        { label: "Group Mode", type: "checkbox", checked: st ? st.groupMode : false, click: () => send("group-mode") },
        { type: "separator" },
        {
          label: "Theme",
          submenu: THEMES.map(t => ({
            label: t.name, type: "radio", checked: (st ? st.theme : "system") === t.key,
            click: () => send(`theme:${t.key}`),
          })),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }]),
      ],
    },
    {
      label: "Facilitate",
      submenu: [
        { label: "Timer…", click: () => send("timer") },
        { label: "Silent Brainstorm…", click: () => send("brainstorm") },
        { label: "Reveal Brainstorm Notes", click: () => send("reveal") },
        { type: "separator" },
        { label: "Vote…", click: () => send("vote") },
        { label: "Consensus Check on Selection", click: () => send("consensus") },
        { type: "separator" },
        { label: "Presentation Mode", accelerator: "CmdOrCtrl+Shift+P", click: () => send("present") },
      ],
    },
    isMac
      ? { role: "windowMenu" }
      : { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching the app again (e.g. from the Start menu) opens another window in the running instance.
  app.on("second-instance", () => createWindow());

  app.whenReady().then(() => {
    buildMenuNow();
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => { if (!isMac) app.quit(); });
}
