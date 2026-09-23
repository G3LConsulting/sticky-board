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
npm run dist         # both, needs a Mac with Wine
```

Requires Node 20+. Electron 44, electron-builder 26. There is no `engines` field, no linter and no `npm test` — the only dev dependencies are electron and electron-builder.

After every edit to `src/sticky-board.html`, run `npm run sync` before anything else: it is the one build step, and it throws if the `<div class="app">` marker it splits on has gone missing.

### Cutting a release

```bash
npm version patch          # or minor / major — bumps package.json and tags vX.Y.Z
git push --follow-tags     # pushes the commit and the tag
```

The tag starts `.github/workflows/release.yml`, which refuses the build unless the tag equals `v` + `package.json` version and `renderer/index.html` matches a fresh `npm run sync`. It then builds on `macos-latest` and `windows-latest` and uploads the installers to a **draft** release for you to check and publish by hand. Builds are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`), so nothing on the runner gets picked up as a certificate. `.github/release-notes-intro.md` is prepended to the auto-generated notes; it carries the first-launch instructions for unsigned builds.

Re-running a build for a tag that already has a release uploads over the existing assets (`--clobber`) rather than creating a second release.

`.claude/skills/release/SKILL.md` drives this end to end — preflight, bump, push, watch the run, report the draft URL — including how to recover when the verify job rejects a tag. Invoke it with `/release` rather than reassembling the git and gh commands by hand.

---

## Git flow — required

**Every change starts on a branch. `main` only ever receives finished, reviewed work.** Nothing is enforced by GitHub settings, so the discipline is the rule: don't commit to `main` directly, including for documentation and config.

```bash
git switch -c feature/parking-lot-filter    # feature/<slug>, or fix/<slug> for a bug
# ... work, committing as you go ...
```

Commit freely on the branch — the messy history disappears at merge time.

### Before a branch may be merged

Both gates, every time:

1. **Review.** Run `/code-review` over the branch diff against `main` and act on what it finds. There's no PR to hang comments off, so this is the only review the change gets.
2. **Run the app.** `npm start`, then actually exercise the change — click it, undo it, save and reopen the file. The app has no test suite and has never been verified on real hardware, so a manual pass is the only thing standing between a regression and a release.

Also confirm `renderer/index.html` was regenerated and committed if `src/` changed (`npm run sync`), or the release build will reject the tag later.

### Merging

```bash
git switch main && git pull
git merge --squash feature/parking-lot-filter
git commit                                  # one clear message describing the feature
git push
git branch -d feature/parking-lot-filter
```

Squash, because GitHub builds release notes from the commits between two tags: one commit per feature makes the notes read like a changelog instead of a work diary. If a branch genuinely needs its individual commits preserved on `main`, use `git merge --no-ff` and say why.

Releases are cut from `main` after the merge, never from a branch — see **Cutting a release**.

## Layout

```
main.js                  Electron main: windows, native menu, dialogs, save/close prompts, IPC
preload.js               the ONLY bridge page ↔ system, exposed as window.stickyDesktop
src/sticky-board.html    THE APP — single file: <title>, <style>, markup, one <script> IIFE
scripts/sync-renderer.js builds renderer/index.html (adds CSP, swaps Google Fonts for @fontsource)
renderer/index.html      GENERATED — never edit, but it IS checked in; regenerate and commit it with src changes
build/icon.png           1024² icon; electron-builder derives .icns / .ico
```

**Edit `src/sticky-board.html`, never `renderer/index.html`.**

`src/sticky-board.html` is a body fragment. It has no `<!doctype>`, `<html>`, `<head>` or `<body>`, because the claude.ai artifact host adds its own wrapper. The sync script adds the wrapper for Electron. Keep it that way so the same file can still be published as an artifact.

`sync-renderer.js` splits the fragment at the **first `<div class="app">`**: everything before it becomes `<head>`, everything from it on becomes `<body>`. So `<title>` and `<style>` must stay above that div, all markup below it, and the div's opening tag must keep that exact spelling. The script also strips the Google Fonts `<link>`s by URL — keep them on their own lines, pointing at `fonts.googleapis.com` / `fonts.gstatic.com`, or the CSP will block them in the desktop build.

`.gitignore` covers `node_modules/` and `dist/`; `renderer/` is deliberately tracked.

---

## How the page adapts to its host

At the top of the script: `const desk = (window.stickyDesktop && window.stickyDesktop.isDesktop) ? window.stickyDesktop : null;` (and further down, `const inArtifact = typeof window.claude?.use === "function"`).

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

Sections are marked `// ================= name =================` — `grep -n '// =\+ .* =\+' src/sticky-board.html` prints the whole map with line numbers, which is the fastest way around a 3,400-line file. Roughly in order:

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

- Code signing and notarisation (macOS Developer ID + notarytool; Windows certificate). Builds are currently unsigned (`mac.identity: null`), which the release workflow makes explicit rather than accidental. Adding it means repo secrets plus a few lines in the `build` job; the rest of the pipeline is unaffected.
- File association for `.board.json` (`build.fileAssociations` + `app.on("open-file")` on macOS + argv handling on Windows).
- A recent projects menu (`app.addRecentDocument` is already called; there's no in-app menu yet).
- Auto-update (electron-updater + a release feed). Deliberately left out for now: on macOS it only works on a signed and notarised build.
- An automated test suite (see Testing).

---

## Keeping the web version in sync

The hosted claude.ai version is published from the same `src/sticky-board.html`. After changes here, it can be republished as is: the artifact host provides `window.claude`, and the desktop code paths stay inactive there.
