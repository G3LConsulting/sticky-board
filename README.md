# Sticky Board — desktop app

Electron wrapper around the Sticky Board web app. Same features as the browser version, plus native Open / Save / Save As, a native menu bar, and one window per project.

## Before you start

**Copy this `app/` folder out of Google Drive first** (for example to `~/Developer/sticky-board`). `npm install` creates a `node_modules` folder of roughly 300 MB with tens of thousands of small files, and Drive will try to sync all of them.

You need **Node.js 20 or newer** (`node -v`). Install it from nodejs.org or with Homebrew (`brew install node`).

## Run it

```bash
npm install
npm start
```

`npm start` rebuilds `renderer/index.html` from `src/sticky-board.html` and opens the app.

## Build installers

| Command | Output (in `dist/`) | Build on |
|---|---|---|
| `npm run dist:mac` | `.dmg` and `.zip` for Apple Silicon and Intel | a Mac |
| `npm run dist:win` | `.exe` installer for x64 and ARM | a Windows PC (a Mac also works if Wine is installed) |
| `npm run dist` | both | a Mac with Wine |

### First launch of an unsigned build

The builds are not code-signed, so both systems warn the first time:

- **macOS:** "Sticky Board can't be opened because Apple cannot check it…". Right-click the app in Applications → **Open** → **Open**. You only do this once. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Sticky Board.app"`.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info** → **Run anyway**.

To remove the warnings you need an Apple Developer ID certificate (with notarisation) and a Windows code-signing certificate; electron-builder picks them up through its standard `CSC_*` / `APPLE_*` environment variables.

## How it's put together

```
app/
├─ main.js                 windows, native menu, file dialogs, save/close prompts
├─ preload.js              the only bridge between page and system (window.stickyDesktop)
├─ src/sticky-board.html   the web app — same file as the claude.ai / browser version
├─ scripts/sync-renderer.js  builds renderer/index.html (adds CSP, swaps Google Fonts for bundled fonts)
├─ renderer/index.html     generated — don't edit by hand
└─ build/icon.png          app icon (electron-builder makes .icns / .ico from it)
```

- **Files:** Save writes straight back to the open `.board.json`; the first Save (or Save As) asks where. Writes go to a temp file first and are then renamed, so a crash mid-save can't corrupt the project.
- **Windows:** File › New Window (⌘N / Ctrl+N) opens another project. Open… uses the current window if it's empty and untouched, otherwise a new one. Opening a file that's already open focuses its window.
- **Closing:** a window with unsaved changes asks Save / Don't Save / Cancel.
- **Menus:** on macOS the native menu bar replaces the in-window File / Edit / View; on Windows the in-window menus stay visible and Alt shows the native bar.
- **Offline:** fonts (Figtree, IBM Plex Mono) are bundled via `@fontsource`, so nothing loads from the internet.
- **Security:** context isolation and sandboxing are on, Node.js is off in the page, a strict Content-Security-Policy is applied, and the app never navigates away or opens pop-ups.

## Updating the app from the web version

1. Copy the latest `sticky-board.html` over `src/sticky-board.html`.
2. `npm start` to check it, then `npm run dist:mac` / `dist:win`.
3. Bump `"version"` in `package.json` for each release.
