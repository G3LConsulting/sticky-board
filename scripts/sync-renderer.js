// Builds renderer/index.html from the shared web source (src/sticky-board.html).
// The web source is the same file that runs on claude.ai / in a browser; this script:
//   - wraps it in a full HTML document with a strict Content-Security-Policy
//   - swaps the Google Fonts link for locally bundled fonts, so the app works offline
// Run automatically by `npm start` and the `dist` scripts.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcFile = path.join(root, "src", "sticky-board.html");
const outDir = path.join(root, "renderer");
const outFile = path.join(outDir, "index.html");

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
const fontLinks = fonts.map(f => `<link rel="stylesheet" href="../node_modules/${f}">`).join("\n");

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const splitAt = src.indexOf('<div class="app">');
if (splitAt < 0) throw new Error('Could not find <div class="app"> in the source file.');
const head = src.slice(0, splitAt);
const body = src.slice(splitAt);

const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${fontLinks}
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`[sync] wrote ${path.relative(root, outFile)} (${Math.round(html.length / 1024)} KB)`);
