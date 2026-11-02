// Serves the packaged website (web/) for the web-shell origin - D0.
//
// Mirrors Firebase Hosting closely enough that the site behaves as it does on
// darknode.ai: an existing file is served as-is, a directory serves its
// index.html, anything else follows the hosting rewrites (the SPA fallback to
// /index.html), and every response carries the header blocks firebase.json sets
// (CSP, X-Frame-Options SAMEORIGIN, nosniff, ...). sync-web copies those rules
// out of firebase.json into web/.hosting.json, so they cannot drift.
//
// Path traversal is impossible by construction: the decoded path is resolved
// under the root and refused unless it stays inside it, NUL bytes and
// backslashes are refused, dot-files (.source.json, .hosting.json) are never
// served (except /.well-known/), and a symlink that points outside the root is refused after realpath.
// Verified by test/webshell/serve.test.mjs.

const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "audio/ogg",
  ".py": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
};
function contentType(file) { return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"; }

// Firebase Hosting glob -> RegExp. Supports **, *, ?, @(a|b) and {a,b}; matched
// against the URL path without its leading slash.
function globToRegExp(glob) {
  const g = String(glob).replace(/^\/+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if ((c === "@" || c === "!" || c === "+") && g[i + 1] === "(") {
      const end = g.indexOf(")", i);
      const alts = g.slice(i + 2, end).split("|").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\\\*|\*/g, "[^/]*"));
      re += "(?:" + alts.join("|") + ")"; i = end;
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      re += "(?:" + g.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")"; i = end;
    } else re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
function globMatch(glob, urlPath) { return globToRegExp(glob).test(String(urlPath).replace(/^\/+/, "")); }

// Every header block whose source matches applies, later blocks overriding
// earlier ones for the same key (Firebase Hosting semantics).
function headersFor(urlPath, hosting) {
  const out = {};
  for (const block of (hosting && hosting.headers) || []) {
    if (!globMatch(block.source, urlPath)) continue;
    for (const h of block.headers || []) out[h.key] = h.value;
  }
  return out;
}

// Resolve a URL path to a file under root. Returns
//   { file }                 an existing regular file to serve
//   { redirect }             a directory requested without its trailing slash
//   { missing: true }        nothing on disk (caller applies rewrites)
//   { forbidden: true }      traversal / NUL / dot-file / symlink escape
function resolveWebPath(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath || "/")); } catch (_) { return { forbidden: true }; }
  if (p.includes("\0") || p.includes("\\")) return { forbidden: true };
  if (!p.startsWith("/")) p = "/" + p;
  const segs = p.split("/");
  if (segs.some((s) => s.startsWith(".") && s !== ".well-known")) return { forbidden: true };
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, "." + p);
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { forbidden: true };
  let st;
  try { st = fs.statSync(abs); } catch (_) { return { missing: true }; }
  let file = abs;
  if (st.isDirectory()) {
    if (!p.endsWith("/")) {
      try { if (fs.statSync(path.join(abs, "index.html")).isFile()) return { redirect: p + "/" }; } catch (_) {}
      return { missing: true };
    }
    file = path.join(abs, "index.html");
    try { if (!fs.statSync(file).isFile()) return { missing: true }; } catch (_) { return { missing: true }; }
  } else if (!st.isFile()) return { missing: true };
  // A symlink inside web/ must not lead outside it.
  try {
    const real = fs.realpathSync(file), realRoot = fs.realpathSync(rootAbs);
    const r = path.relative(realRoot, real);
    if (r.startsWith("..") || path.isAbsolute(r)) return { forbidden: true };
  } catch (_) { return { missing: true }; }
  return { file };
}

// Firebase rewrites that point at a destination file ({source, destination}).
// Function/run rewrites have no local backend and are skipped (404).
function rewriteFor(urlPath, hosting) {
  for (const r of (hosting && hosting.rewrites) || []) {
    if (!globMatch(r.source, urlPath)) continue;
    if (r.destination) return { destination: r.destination };
    return { backend: true };
  }
  return null;
}

// Pure request -> response description (no Response object) for testability.
function route(root, hosting, method, urlPath) {
  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { Allow: "GET, HEAD" } };
  const base = headersFor(urlPath, hosting);
  const r = resolveWebPath(root, urlPath);
  if (r.forbidden) return { status: 403, headers: base };
  if (r.redirect) return { status: 301, headers: Object.assign({}, base, { Location: r.redirect }) };
  if (r.file) return { status: 200, file: r.file, headers: base };
  const rw = rewriteFor(urlPath, hosting);
  if (rw && rw.destination) {
    const d = resolveWebPath(root, rw.destination);
    if (d.file) return { status: 200, file: d.file, headers: base };
  }
  return { status: 404, headers: base };
}

// Build the protocol.handle callback for the app origin. Local files are always
// revalidated (no-cache) so an app update can never be shadowed by a stale copy
// in Chromium's HTTP cache, which persists in the app partition.
// `transform(urlPath, buffer)` may return a replacement body (used to point the
// site's Firebase SDK imports at the vendored copy).
function createHandler({ root, hosting, extraHeaders, transform }) {
  return async function handle(request) {
    const u = new URL(request.url);
    const res = route(root, hosting, request.method, u.pathname);
    const headers = Object.assign({}, res.headers, extraHeaders ? extraHeaders(u.pathname) : null);
    if (res.status !== 200) {
      return new Response(res.status === 301 ? null : String(res.status), { status: res.status, headers: Object.assign(headers, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" }) });
    }
    headers["Content-Type"] = contentType(res.file);
    headers["Cache-Control"] = "no-cache";
    let body = request.method === "HEAD" ? null : await fs.promises.readFile(res.file);
    if (body && transform) body = transform(u.pathname, body, res.file) || body;
    return new Response(body, { status: 200, headers });
  };
}

module.exports = { contentType, globToRegExp, globMatch, headersFor, resolveWebPath, rewriteFor, route, createHandler };
