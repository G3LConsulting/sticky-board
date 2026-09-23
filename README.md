# Sticky Board

A sticky-note board for architecture sessions and workshops. It runs three ways from one codebase:

- **Desktop app** (macOS + Windows) — native Open / Save / Save As, a native menu bar, one window per project.
- **Shared board** — a small Node server hands out a link; everyone who opens it edits the same board live from their own device.
- **Web page** — the same file, published as a claude.ai artifact or opened straight from disk.

## Before you start

**Copy this `app/` folder out of Google Drive first** (for example to `~/Developer/sticky-board`). `npm install` creates a `node_modules` folder of roughly 300 MB with tens of thousands of small files, and Drive will try to sync all of them.

You need **Node.js 20 or newer** (`node -v`). Install it from nodejs.org or with Homebrew (`brew install node`).

## Run it

```bash
npm install
npm start
```

`npm start` rebuilds `renderer/index.html` from `src/sticky-board.html` and opens the app.

Run the tests with `npm test`.

## Share a board with the room

```bash
npm run serve            # http://localhost:8080
PORT=80 HOST=0.0.0.0 npm run serve
```

Open the page, press **Share**, and give people the link it shows you — `https://your-host/b/<code>`.
Anyone who opens it joins the same board: notes appear as they are written, you can see everyone's
cursor, and the person who created the board runs the voting.

From the desktop app it is **File ▸ Share board…** (it asks for your server's address once) or
**File ▸ Join board…** to paste a link somebody sent you.

A few things worth knowing before you use it in front of a client:

- **The link is the password.** There are no accounts. Anyone who has it can edit, so share it the
  way you would share the room itself. The codes are long and random, so nobody finds one by guessing.
- **The facilitator runs the session.** Whoever created the board starts and closes votes, and
  reveals a silent brainstorm. Everyone else votes from their own phone and sees the tally live.
- **Face-down notes really are face-down.** During a silent brainstorm the text of a note never
  leaves the device that wrote it until the facilitator reveals it — not hidden in the page, just
  not sent.
- **Save still means a file.** Saving writes a copy of the board to disk. The shared board carries
  on regardless; the server keeps it and hands it back when people return.
- **It speaks plain HTTP.** Put it behind a reverse proxy with TLS if it is going on the internet.
  A public instance also limits how many boards one address can create per hour — raise it with
  `SB_ROOMS_PER_HOUR` if 60 is not enough.

Rooms are stored in `server/data/` as ordinary `.board.json` files, so one can be opened in the app
if it ever needs recovering by hand.

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
├─ main.js                 windows, native menu, file dialogs, save/close prompts, room socket
├─ preload.js              the only bridge between page and system (window.stickyDesktop)
├─ src/sticky-board.html   the web app — same file as the claude.ai / browser version
├─ scripts/sync-renderer.js  builds the two generated pages (CSP, bundled fonts)
├─ renderer/index.html     generated for the desktop app — don't edit by hand
├─ server/                 the collaboration server (and server/public, generated)
├─ test/                   npm test
└─ build/icon.png          app icon (electron-builder makes .icns / .ico from it)
```

- **Files:** Save writes straight back to the open `.board.json`; the first Save (or Save As) asks where. Writes go to a temp file first and are then renamed, so a crash mid-save can't corrupt the project.
- **Windows:** File › New Window (⌘N / Ctrl+N) opens another project. Open… uses the current window if it's empty and untouched, otherwise a new one. Opening a file that's already open focuses its window.
- **Closing:** a window with unsaved changes asks Save / Don't Save / Cancel.
- **Menus:** on macOS the native menu bar replaces the in-window File / Edit / View; on Windows the in-window menus stay visible and Alt shows the native bar.
- **Offline:** fonts (Figtree, IBM Plex Mono) are bundled via `@fontsource`, so nothing loads from the internet.
- **Sharing:** the desktop app's connection to a board server is made by the main process, not the page, so the page keeps its strict policy of contacting nothing at all.
- **Security:** context isolation and sandboxing are on, Node.js is off in the page, a strict Content-Security-Policy is applied, and the app never navigates away or opens pop-ups.

## Releases

Releases are built by GitHub Actions, not on your machine:

```bash
npm version patch          # bumps package.json and creates the tag
git push --follow-tags
```

That builds the macOS and Windows installers on GitHub's runners and attaches them to a **draft** release. Open the release on GitHub, check the assets, edit the notes and press publish. The workflow fails early if the tag doesn't match `package.json` or if `renderer/index.html` is out of date with `src/`.

To rebuild a tag without moving it, run the **Release** workflow manually from the Actions tab and give it the tag name; it replaces the assets on the existing release.

## Updating the app from the web version

1. Copy the latest `sticky-board.html` over `src/sticky-board.html`.
2. `npm start` to check it, then `npm run dist:mac` / `dist:win`.
3. Release with `npm version` + `git push --follow-tags` (see above).
