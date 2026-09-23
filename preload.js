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
});
