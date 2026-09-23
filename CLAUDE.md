# Sticky Board — guide for Claude Code

A sticky-note board for architecture sessions and workshops. One codebase runs as a **web page** (browser or claude.ai artifact), as an **Electron desktop app** (macOS + Windows), and — served by the small Node server in `server/` — as a **live shared board** that a whole room edits at once.

Owner: Angelo Dejaeghere (angelo@g3l.be). UI copy is British English.

---

## Commands

```bash
npm install          # first time
npm start            # sync renderer + run the desktop app
npm run serve        # sync + run the collaboration server on :8080
npm test             # node --test: merge rules, the protocol, two pages syncing
npm run sync         # rebuild both generated pages from src/ only
npm run dist:mac     # one .dmg each for Apple Silicon and Intel (build on a Mac)
npm run dist:win     # one NSIS .exe each for x64 and ARM (build on Windows, or a Mac with Wine)
npm run dist         # both, needs a Mac with Wine
```

Requires Node 20+. Electron 44, electron-builder 26. There is no `engines` field and no linter. The only runtime dependencies are `@fontsource` (bundled fonts) and `ws`; dev dependencies are electron, electron-builder and jsdom.

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
main.js                  Electron main: windows, native menu, dialogs, save/close prompts, IPC,
                         and the WebSocket for shared boards (the page never opens one itself)
preload.js               the ONLY bridge page ↔ system, exposed as window.stickyDesktop
src/sticky-board.html    THE APP — single file: <title>, <style>, markup, one <script> IIFE
scripts/sync-renderer.js builds BOTH generated pages (CSP, fonts, the collaboration marker)
renderer/index.html      GENERATED for Electron — never edit, but it IS checked in; regenerate and
                         commit it with src changes
server/                  the collaboration server — see "Sharing a board"
server/public/index.html GENERATED for the server — not checked in; `npm run serve` rebuilds it
server/data/             live room documents — not checked in
test/                    node --test suite (see Testing)
build/icon.png           1024² icon; electron-builder derives .icns / .ico
```

**Edit `src/sticky-board.html`, never `renderer/index.html`.**

`src/sticky-board.html` is a body fragment. It has no `<!doctype>`, `<html>`, `<head>` or `<body>`, because the claude.ai artifact host adds its own wrapper. The sync script adds the wrapper for Electron. Keep it that way so the same file can still be published as an artifact.

`sync-renderer.js` splits the fragment at the **first `<div class="app">`**: everything before it becomes `<head>`, everything from it on becomes `<body>`. So `<title>` and `<style>` must stay above that div, all markup below it, and the div's opening tag must keep that exact spelling. The script also strips the Google Fonts `<link>`s by URL — keep them on their own lines, pointing at `fonts.googleapis.com` / `fonts.gstatic.com`, or the CSP will block them in the desktop build.

`.gitignore` covers `node_modules/`, `dist/`, `server/public/` and `server/data/`; `renderer/` is deliberately tracked, because the release workflow rejects a tag whose `renderer/index.html` does not match a fresh `npm run sync`. `server/public/` needs no such guarantee, so it is generated on the fly.

---

## How the page adapts to its host

At the top of the script: `const desk = (window.stickyDesktop && window.stickyDesktop.isDesktop) ? window.stickyDesktop : null;` (and further down, `const inArtifact = typeof window.claude?.use === "function"`).

A fourth host sits alongside these: the page served by `server/`, which is the same file plus a `<meta name="sb-collab">` marker. That marker is the only thing that switches the sharing UI on, so a plain file or an artifact — neither of which has a server to talk to — never shows a Share button it cannot honour.

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

Shared boards add `sb:room-create`, `sb:room-connect`, `sb:room-send`, `sb:room-close`, `sb:room-message`, `sb:room-status`. **The WebSocket lives in the main process, not the page.** That is deliberate: it means `renderer/index.html` keeps its strict `connect-src 'self'` whatever server somebody joins, and the preload still exposes named functions only.

Rules: the page never receives file paths it can use directly. Main keeps `filePath` per window and only accepts a path it handed out itself (`pendingPath` + `sb:opened`). Writes are atomic (temp file + rename).

---

## Security — don't regress

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Navigation is blocked (`will-navigate`), `setWindowOpenHandler` denies new windows, and http(s) links go to the system browser.
- A strict CSP is injected by `sync-renderer.js`: no remote scripts, styles or fonts. **Never add a CDN dependency.** Bundle it (see how `@fontsource` works).
- The preload exposes named functions only. Never expose `ipcRenderer` itself.

---

## Sharing a board

`npm run serve` starts one Node process that serves the page **and** the WebSocket on the same
port, so the whole thing deploys as a single artefact — a VPS behind TLS, or the facilitator's
laptop on the office wifi. `POST /api/rooms` creates a room from a document and returns its id;
`GET /b/<id>` serves the app, which reads the id out of the URL and joins.

**The link is the credential.** There are no accounts: anyone holding the link can edit. That is
the point — sharing a board is as quick as pasting a URL into a meeting chat — and it is why room
ids are 160 random bits and why nothing anywhere lists them.

### How the merge works

The wire format is **entities, not documents**. `server/entities.js` splits a board into
independently addressable pieces, and the page keeps a copy of the same split (`toEnts` in the
collaboration section — **change one and you must change the other**):

```
meta · board:<bid> · note:<bid>:<id> · frame:<bid>:<id> · link:<bid>:<id>
park:<id> · vote:<bid> · brainstorm:<bid>
```

A client only ever sends entities that **actually differ** from what the server last confirmed
(`diffEnts` against `room.base`), so nobody echoes a stale value back over someone else's newer
one. With one server there is one arrival order, so the last patch to land wins per entity: two
people dragging different notes both land; two people editing the same note's text is
last-writer-wins, which is the accepted trade for a workshop tool rather than a document editor.

`activeBoard` is **not** an entity — which board tab you are looking at is yours alone.

Three things follow from this and are easy to break:

- **`changed()` is still the one choke point.** It calls `collabPush()`, which computes the diff
  and returns the entity keys the change touched. Every mutation must keep going through it.
- **Undo restores keys, not documents.** An undo entry is `{snap, keys}`; in a room only `keys`
  are put back, so undoing your own work leaves everything other people did untouched. A plain
  whole-document restore would silently delete their notes.
- **A note being edited ignores remote text.** `applyRemote` keeps the local text while
  `editingId` matches, so nobody's typing gets yanked out from under them.

### Face-down notes

`hidden` notes must never leak, and over a network that becomes a **server** responsibility, not a
rendering one. `redactFor` blanks the text of a hidden note for everyone except its author, so the
words are never on the wire at all. Authorship (`note.by`) is stamped by the server from the
connection that created the note, so a client cannot claim someone else's note to read it.

### Roles

The first person in a room is the facilitator and the server **rejects** `vote:*` and
`brainstorm:*` patches from anyone else — the hidden button in the UI is a courtesy, not the
control. If the facilitator leaves, the longest-connected peer is promoted so the room stays
usable. Voting and the consensus check are per person: a ballot carries `by`, so everyone votes at
once from their own device instead of passing a laptop.

### Persistence and limits

A room is written to `server/data/<id>.json` as an ordinary board document (open it in the app if
you ever need to recover one by hand) — atomically, debounced, plus on last-peer-leave and on
`SIGTERM`. Rooms load lazily and leave memory after 30 idle minutes. There are caps on message
size, patch and cursor rate, peers per room, rooms per server (counting the ones on disk, not just
the ones in memory) and new rooms per address per hour (`SB_ROOMS_PER_HOUR`, default 60), an origin
check on the upgrade, and **every inbound entity is re-validated** in `server/validate.js` —
including the document posted to `/api/rooms`.

Two ordering traps worth knowing about, both fixed and both easy to reintroduce: the WebSocket
message listener is attached **before** the room is read off disk (a `hello` arriving during the
read would otherwise be dropped on the floor and the page would sit on "Connecting…" forever), and
`Rooms.get` shares one in-flight load per room (two people opening a cold link at once would
otherwise end up on two separate documents that overwrite each other's save file).

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

Collaboration adds only optional fields, so the format stays version 2 and old files open
unchanged: `note.by` (author), `voters[].by` (whose ballot), and on `consensus` a parallel `by[]`
plus `open` / `shown` for a check that is still running or whose result is on screen. All of them
go through `normalise()` and `server/validate.js`. **A room id is never saved to a file** — a file
is a snapshot, the room is the live record.

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

`npm test` runs `node --test` over `test/`:

- **`merge.test.js`** — the merge rules as pure functions: concurrent edits, tombstones, deltas,
  redaction, authorship spoofing, sanitising. This is where a bug loses someone's work silently.
- **`server.test.js`** — the protocol over a real socket: joining, roles, deltas, persistence.
- **`page.test.js`** — boots both generated pages in jsdom. The app is one long IIFE, so the most
  valuable assertion is simply that it still runs start to finish.
- **`collab.test.js`** — two real pages against a real server: a note crossing between them, the
  editing guard, undo isolation, and a face-down note never reaching the other device.

jsdom needs stubs for `setPointerCapture`, `matchMedia`, canvas `getContext`/`measureText`,
`innerText` and `elementFromPoint`; `boot()` in `page.test.js` has them. The runner is given
`--test-force-exit`, because a listening server and open jsdom windows otherwise hold the loop.

Still not covered, and still worth doing:

1. **Desktop bridge** — the same jsdom setup plus a fake `window.stickyDesktop` recording calls,
   driving `runCommand` (open, save, save-as, exports, save-then-close) and the room relay.
2. **Main process** — require `main.js` with `Module._load` patched to return a mock `electron`,
   and test save/open/export, "open same file focuses window" and the close prompt.
3. **Packaging** — `npx electron-builder --linux dir`, then `npx @electron/asar list` to confirm
   `renderer/`, `@fontsource` and `ws` are all in the asar.

**Not yet verified on real hardware:** the desktop app has never been run on a Mac or a PC. Check
native menus, dialogs, the close prompt, full-screen presentation, font loading — and File ▸ Share
board / Join board against a running server.

## Open items

- Code signing and notarisation (macOS Developer ID + notarytool; Windows certificate). Builds are currently unsigned (`mac.identity: null`), which the release workflow makes explicit rather than accidental. Adding it means repo secrets plus a few lines in the `build` job; the rest of the pipeline is unaffected.
- File association for `.board.json` (`build.fileAssociations` + `app.on("open-file")` on macOS + argv handling on Windows).
- A recent projects menu (`app.addRecentDocument` is already called; there's no in-app menu yet).
- Auto-update (electron-updater + a release feed). Deliberately left out for now: on macOS it only works on a signed and notarised build.
- Desktop, main-process and packaging tests (see Testing).
- TLS and a real deployment for `server/` — it speaks plain HTTP and expects a reverse proxy in
  front of it. Also no rate limit per IP on room creation, only a cap on rooms per server.
- A room has no way to be ended or handed over deliberately; the facilitator role only moves when
  somebody leaves.

---

## Keeping the web version in sync

The hosted claude.ai version is published from the same `src/sticky-board.html`. After changes here, it can be republished as is: the artifact host provides `window.claude`, and the desktop code paths stay inactive there.
