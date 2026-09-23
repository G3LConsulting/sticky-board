# Sticky Board — guide for Claude Code

A sticky-note board for architecture sessions and workshops. One codebase runs as a **web page** (browser or claude.ai artifact) and as an **Electron desktop app** (macOS + Windows).

Owner: Angelo Dejaeghere (angelo@g3l.be). UI copy is British English.

---

## Commands

```bash
npm install          # first time
npm start            # sync renderer + run the desktop app
npm run sync         # rebuild renderer/index.html from src/ only
npm run dist:mac     # .dmg + .zip, Apple Silicon + Intel (build on a Mac)
npm run dist:win     # NSIS .exe, x64 + ARM (build on Windows, or a Mac with Wine)
```

Requires Node 20+. Electron 44, electron-builder 26.

---

## Layout

```
main.js                  Electron main: windows, native menu, dialogs, save/close prompts, IPC
preload.js               the ONLY bridge page ↔ system, exposed as window.stickyDesktop
src/sticky-board.html    THE APP — single file: <title>, <style>, markup, one <script> IIFE
scripts/sync-renderer.js builds renderer/index.html (adds CSP, swaps Google Fonts for @fontsource)
renderer/index.html      GENERATED — never edit, not committed
build/icon.png           1024² icon; electron-builder derives .icns / .ico
```

**Edit `src/sticky-board.html`, never `renderer/index.html`.**

`src/sticky-board.html` is a body fragment. It has no `<!doctype>`, `<html>`, `<head>` or `<body>`, because the claude.ai artifact host adds its own wrapper. The sync script adds the wrapper for Electron. Keep it that way so the same file can still be published as an artifact.

---

## How the page adapts to its host

At the top of the script: `const desk = window.stickyDesktop?.isDesktop ? window.stickyDesktop : null;`

| Concern | Desktop (`desk`) | claude.ai artifact (`inArtifact`) | Plain browser |
|---|---|---|---|
| Save / Open project | `desk.saveProject` / `desk.openProject` → native dialogs, writes to same file | `claude.use("downloads")` / file input | File System Access API → download fallback |
| Exports (PNG/SVG/MD) | `desk.exportFile` | downloads capability | save picker / download |
| Draft in localStorage | **off** (each window = one file) | on | on |
| ⌘S/⌘Z/⌘D/⌘G/⌘F/⌘A/⌘N/⌘O/⌘W | handled by the native menu; the page ignores them | page | page |
| In-page File/Edit/View bar | hidden on macOS (`.desktop-darwin`), shown on Windows | shown | shown |

Native menu → page: `main.js` sends `sb:command` strings, which the page runs in **`runCommand(cmd)`** (for example `save`, `export-png`, `theme:easy`, `template-board:retro`, `consensus`). **When you add a feature to the menus, add it in three places:** the in-page menu (`mItem(...)` in the File/Edit/View builders), `runCommand`, and the native template in `main.js` `buildMenuNow()`.

Page → main: `desk.setState({dirty, project, snap, groupMode, theme, presenting, compare, side})` is called from `syncDesk()`. It drives the window title (• / edited dot) and the native menu checkboxes.

### IPC channels (main.js ↔ preload.js)

`sb:init` (sync: platform, sample), `sb:open`, `sb:opened`, `sb:save`, `sb:export`, `sb:confirm-discard`, `sb:state`, `sb:close-after-save`, `sb:command`, `sb:open-file`.

Rules: the page never receives file paths it can use directly. Main keeps `filePath` per window and only accepts a path it handed out itself (`pendingPath` + `sb:opened`). Writes are atomic (temp file + rename).

---

## Security — don't regress

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Navigation is blocked (`will-navigate`), `setWindowOpenHandler` denies new windows, and http(s) links go to the system browser.
- A strict CSP is injected by `sync-renderer.js`: no remote scripts, styles or fonts. **Never add a CDN dependency.** Bundle it (see how `@fontsource` works).
- The preload exposes named functions only. Never expose `ipcRenderer` itself.

---

## Data model — `*.board.json`

One project is one file. `normalise(s)` validates and fills defaults on load, and **every new field needs handling there**.

```js
{
  format: "sticky-board", version: 2,
  project: "Name", snap: true,
  legend: { yellow, green, red, blue, orange },        // colour meaning, "" = unnamed
  linkDefaults: { style, color, width, heads },         // last-used arrow style
  parking: [{ id, text, color, w, h, from, parkedAt, done?, consensus? }],
  activeBoard: "id",
  boards: [{
    id, name,
    notes:  [{ id, x, y, w, h, color, text, z, hidden?, done?, consensus?: { votes:[0-5], at } }],
    frames: [{ id, x, y, w, h, title }],
    links:  [{ id, from, to, label, style, color, width, heads }],
    vote:   null | { status:"active"|"closed", type:"dots"|"thumbs", dotsPerVoter, startedAt,
                     voters:[{ dots:{noteId:n} } | { thumbs:{noteId:±1} }] },
    brainstorm: null | { active:true, startedAt }
  }]
}
```

- **Tags live in note text:** `#tag`, `@owner`. `parseTags()` reads them and `displayText()` strips them for display. `#action` makes a note an action (`done` flag); `#decision` makes it a decision.
- A note belongs to a frame when its **centre** is inside the frame (`inside(n, f)`). No explicit parent ids.
- `hidden` notes (silent brainstorm) must never leak their text: they're excluded from search, filters, side panel, spotlight and exports.

---

## Code map (inside the script IIFE in `src/sticky-board.html`)

Sections are marked `// ================= name =================`. Roughly in order:

- **state:** `normalise`, `loadDraft`/`saveDraft`, **undo/redo** (`changed(key?)` snapshots the whole state; call it after every mutation, and pass a key to coalesce rapid edits).
- **view:** zoom/pan (`view()`, `applyView()`, `toWorld()`, `fitAll()`, `fitBox()`), minimap.
- **rendering:** `renderAll()` → tabs, rail, `renderBoard()` (frames, notes, links, dots, search), bars, side panel, compare.
- **selection toolbar:** `renderToolbar()`, menus `openAlignMenu` / `openCopyMenu` / `openMarkMenu` / `openLinkMenu`.
- **editing, creating, moving:** `startEdit`, `makeNote`, `startMove` (drag, group-mode drop, drop-to-park), `startResize`, `startConnect`.
- **links:** `curve()`, `trimCurve()`, `renderLinks()`.
- **search and tag filter:** `applySearch()`.
- **voting:** `tallies()`, `ranking()`, `renderVote()`, `votePrimary`/`voteSecondary`.
- **facilitation:** templates (`templateData`), silent brainstorm, side panel (actions / decisions / parking), consensus check (`cs`), priority matrix (`createMatrixBoard`), compare boards (`cmp`), timer, presentation (spotlight `spotId`, focus `focusId`).
- **export:** `buildScene(board, {world, palette})` → `sceneToSVG` / `sceneToCanvas` (always light palette, `EX`); `buildMarkdown()` uses vault project-note frontmatter.
- **menus:** `mItem`, File/Edit/View builders; **theme** (`applyTheme`, `data-sb-theme` on `<html>`).
- **desktop bridge:** `syncDesk`, `runCommand`; **boot** at the very end.

Most helpers are hoisted function declarations. Module state is `let`/`const`, so anything that runs at load time must come after the declarations it uses (boot is last for that reason).

---

## Conventions

- **UI copy:** sentence case, British spelling, verbs on buttons ("Save", "Reveal all"). Errors say what happened and what to do. No "please", no exclamation marks.
- **Confirmations:** `alert`/`confirm`/`prompt` don't work in the artifact host. Use the in-place "armed" pattern instead: the first click relabels the button ("Discard unsaved changes?") and the second click confirms. See `arm()` and the File › New project item.
- **Styling:** colours come from CSS tokens on `:root`. Four themes: System (no attribute), `data-sb-theme="light" | "dark" | "easy"`. Sticky-note colours are `--n-{colour}`; arrow colours are `--l-{colour}`. Any new colour needs a value in every theme block.
- Keep the global `[hidden]{display:none!important}` rule. Many bars use `display:flex` and rely on it.
- **Accessibility:** every control needs a label; icon-only buttons get `aria-label`; respect `prefers-reduced-motion`.
- **Exports** must not depend on the current theme (they use `EX`). The compare view uses `themePalette()`.

---

## Testing

There's no test suite in the repo yet. During development the checks were:

1. **Renderer (jsdom):** load `src/sticky-board.html` into jsdom with stubs for `setPointerCapture`, `matchMedia`, canvas `getContext`/`measureText`, `innerText`, and `elementFromPoint`. Then drive the UI by clicking buttons and dispatching `pointerdown`/`pointerup`/`keydown`, and assert on the DOM and on `localStorage["sticky-board-draft-v1"]`. Clear any running timer interval with `process.exit` at the end.
2. **Desktop bridge:** the same jsdom setup, plus a fake `window.stickyDesktop` recording calls. Check `runCommand` flows (open, save, save-as, exports, save-then-close).
3. **Main process:** require `main.js` with `Module._load` patched to return a mock `electron` (BrowserWindow, dialog queue, ipcMain registry). Test save/open/export, "open same file focuses window", and the close prompt (Save / Don't Save / Cancel).
4. **Packaging:** `npx electron-builder --linux dir`, then `npx @electron/asar list dist/linux-unpacked/resources/app.asar` to confirm `renderer/` and `@fontsource` files are included.

A good first task is to turn 1–3 into `test/` with a `npm test` script (`node --test` + jsdom).

**Not yet verified on real hardware:** `npm start` on a Mac or PC has never been run. Check native menus, dialogs, the close prompt, the full-screen presentation and font loading first.

---

## Open items

- Code signing and notarisation (macOS Developer ID + notarytool; Windows certificate). Builds are currently unsigned (`mac.identity: null`).
- File association for `.board.json` (`build.fileAssociations` + `app.on("open-file")` on macOS + argv handling on Windows).
- A recent projects menu (`app.addRecentDocument` is already called; there's no in-app menu yet).
- Auto-update (electron-updater + a release feed).
- An automated test suite (see Testing).

---

## Keeping the web version in sync

The hosted claude.ai version is published from the same `src/sticky-board.html`. After changes here, it can be republished as is: the artifact host provides `window.claude`, and the desktop code paths stay inactive there.
