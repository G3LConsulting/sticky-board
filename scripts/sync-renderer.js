// Builds the two hosted copies of the app from the shared web source (src/sticky-board.html).
//
//   renderer/index.html      the Electron desktop build — fonts bundled from node_modules,
//                            no network of any kind. Checked in; the release workflow rejects a
//                            tag whose renderer/index.html does not match a fresh run of this.
//   server/public/index.html the copy the collaboration server hands out. Same page, but fonts
//                            come from /fonts and the CSP lets it open a socket back to its own
//                            origin. Generated, not checked in.
//
// The source itself stays a bare body fragment so the very same file can still be published as a
// claude.ai artifact, where the host supplies its own wrapper.
//
// Run automatically by `npm start`, `npm run serve` and the `dist` scripts.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcFile = path.join(root, "src", "sticky-board.html");

let src = fs.readFileSync(srcFile, "utf8");

// Drop the Google Fonts preconnect + stylesheet lines.
src = src.replace(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>\s*/g, "");

const fonts = [
  "@fontsource/figtree/400.css",
  "@fontsource/figtree/500.css",
  "@fontsource/figtree/600.css",
  "@fontsource/figtree/700.css",
  "@fontsource/ibm-plex-mono/400.css",
  "@fontsource/ibm-plex-mono/500.css",
];
for (const f of fonts) {
  if (!fs.existsSync(path.join(root, "node_modules", f))) {
    console.warn(`[sync] ${f} not found — run "npm install" first. The app will fall back to system fonts.`);
  }
}

const splitAt = src.indexOf('<div class="app">');
if (splitAt < 0) throw new Error('Could not find <div class="app"> in the source file.');
const head = src.slice(0, splitAt);
const body = src.slice(splitAt);

function build({ csp, fontHref, extraHead = "" }) {
  const links = fonts.map(f => `<link rel="stylesheet" href="${fontHref(f)}">`).join("\n");
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
${extraHead}${links}
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;
}

function write(file, html) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  console.log(`[sync] wrote ${path.relative(root, file)} (${Math.round(html.length / 1024)} KB)`);
}

// ---------- desktop ----------
// No remote anything. The desktop app's collaboration socket is held by the main process and
// reaches the page over IPC, so this policy never has to name a server.
write(path.join(root, "renderer", "index.html"), build({
  csp: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ],
  fontHref: f => `../node_modules/${f}`,
}));

// ---------- served by the collaboration server ----------
// `connect-src 'self'` covers a WebSocket back to the same origin, so the page can still only
// talk to the server that served it. Paths are absolute because a room link is /b/<id>.
// The marker is what switches the sharing UI on: the same source served anywhere else — a plain
// browser, a claude.ai artifact — has no server to talk to and hides it.
write(path.join(root, "server", "public", "index.html"), build({
  csp: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ],
  fontHref: f => `/fonts/${f.replace("@fontsource/", "")}`,
  extraHead: '<meta name="sb-collab" content="1">\n',
}));
