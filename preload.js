// Sticky Board — preload bridge
// Exposes a small, explicit API to the page as window.stickyDesktop.
// The page never gets Node.js or file-system access; every file operation goes through a native dialog in main.js.

const { contextBridge, ipcRenderer } = require("electron");

const init = ipcRenderer.sendSync("sb:init") || {};

contextBridge.exposeInMainWorld("stickyDesktop", {
  isDesktop: true,
  platform: init.platform,          // "darwin" | "win32" | "linux"
  sample: !!init.sample,            // first window on first launch shows the sample project

  openProject: opts => ipcRenderer.invoke("sb:open", opts),
  opened: ok => ipcRenderer.send("sb:opened", !!ok),
  saveProject: opts => ipcRenderer.invoke("sb:save", opts),
  exportFile: opts => ipcRenderer.invoke("sb:export", opts),
  confirmDiscard: () => ipcRenderer.invoke("sb:confirm-discard"),
  setState: s => ipcRenderer.send("sb:state", s),
  closeAfterSave: ok => ipcRenderer.send("sb:close-after-save", !!ok),

  onCommand: cb => { ipcRenderer.on("sb:command", (_e, cmd) => cb(cmd)); },
  onOpenFile: cb => { ipcRenderer.on("sb:open-file", (_e, file) => cb(file)); },

  // Shared boards. The WebSocket itself lives in the main process: the page never opens a
  // connection of its own, so the renderer's Content-Security-Policy never has to name a server.
  room: {
    create: opts => ipcRenderer.invoke("sb:room-create", opts),
    connect: opts => ipcRenderer.send("sb:room-connect", opts),
    send: msg => ipcRenderer.send("sb:room-send", msg),
    close: () => ipcRenderer.send("sb:room-close"),
    onMessage: cb => { ipcRenderer.on("sb:room-message", (_e, msg) => cb(msg)); },
    onStatus: cb => { ipcRenderer.on("sb:room-status", (_e, st) => cb(st)); },
  },
});
