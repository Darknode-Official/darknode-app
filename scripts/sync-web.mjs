#!/usr/bin/env node
// sync-web: package the Darknode website into the desktop app (D0).
//
// Copies darknode-web/public into ./web so the app serves the website's own UI
// and tools locally (offline, from the app's origin) instead of loading the live
// site. Runs from `prestart` and every `predist*` hook; web/ is generated, not
// committed (it is ~60 MB and would duplicate the web repo's history).
//
//   node scripts/sync-web.mjs [path/to/darknode-web/public] [--no-vendor] [--max-mb N]
//   DARKNODE_WEB=/path/to/public node scripts/sync-web.mjs
//
// What it does:
//   - copies every file except public/downloads (installers), anything matching
//     firebase.json's hosting `ignore` list, symlinks, and files over 20 MB, and
//     reports each exclusion;
//   - writes web/.hosting.json with firebase.json's hosting headers + rewrites
//     (so the app serves the same CSP/X-Frame-Options/... and SPA fallback);
//   - vendors the Firebase SDK modules the site imports from www.gstatic.com into
//     web/__vendor/ (cached under .cache/web-vendor so offline rebuilds work),
//     because the console cannot boot offline without them;
//   - records the source commit, branch, dirty state and every exclusion in
//     web/.source.json.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, "..");
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
// Remote ES modules the site imports on its boot path. Only exact, versioned
// gstatic Firebase URLs are vendored; anything else stays network-only.
const VENDOR_URL_RE = /https:\/\/www\.gstatic\.com\/firebasejs\/\d+\.\d+\.\d+\/[a-z0-9-]+\.js/g;

// firebase.json `ignore` globs -> predicate over a POSIX relative path.
function ignoreMatcher(globs) {
  const res = (globs || []).map((g) => {
    let re = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "*" && g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else if (c === "*") re += "[^/]*";
      else re += c.replace(/[.+^${}()|[\]\\/?]/g, "\\$&");
    }
    return new RegExp("^" + re + "(?:/.*)?$");
  });
  return (rel) => res.some((r) => r.test(rel));
}

function git(dir, args) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (_) { return null; }
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function readHosting(repoRoot) {
  const fj = path.join(repoRoot, "firebase.json");
  if (!fs.existsSync(fj)) return null;
  const cfg = JSON.parse(fs.readFileSync(fj, "utf8"));
  const hosting = Array.isArray(cfg.hosting) ? cfg.hosting[0] : cfg.hosting;
  if (!hosting) return null;
  return { headers: hosting.headers || [], rewrites: hosting.rewrites || [], ignore: hosting.ignore || [] };
}

// Copy src -> dest. Returns { files, bytes, excluded[] }.
function copyTree(src, dest, { maxBytes, isIgnored }) {
  const out = { files: 0, bytes: 0, excluded: [] };
  const walk = (rel) => {
    const from = path.join(src, rel);
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const r = rel ? rel + "/" + ent.name : ent.name;
      const abs = path.join(src, r);
      if (r === "downloads" && ent.isDirectory()) { out.excluded.push({ path: r + "/", reason: "installers (public/downloads)", bytes: dirBytes(abs) }); continue; }
      if (isIgnored(r)) { out.excluded.push({ path: r + (ent.isDirectory() ? "/" : ""), reason: "firebase.json hosting ignore", bytes: ent.isDirectory() ? dirBytes(abs) : fs.statSync(abs).size }); continue; }
      if (ent.isSymbolicLink()) { out.excluded.push({ path: r, reason: "symlink (not followed)", bytes: 0 }); continue; }
      if (ent.isDirectory()) { fs.mkdirSync(path.join(dest, r), { recursive: true }); walk(r); continue; }
      if (!ent.isFile()) continue;
      const size = fs.statSync(abs).size;
      if (size > maxBytes) { out.excluded.push({ path: r, reason: "over " + Math.round(maxBytes / 1048576) + " MB", bytes: size }); continue; }
      fs.copyFileSync(abs, path.join(dest, r));
      out.files++; out.bytes += size;
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walk("");
  return out;
}

function dirBytes(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += dirBytes(p); else if (ent.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

function scanVendorUrls(dir) {
  const urls = new Set();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "__vendor") walk(p); continue; }
      if (!/\.(m?js|html)$/.test(ent.name)) continue;
      const m = fs.readFileSync(p, "utf8").match(VENDOR_URL_RE);
      if (m) m.forEach((u) => urls.add(u));
    }
  };
  walk(dir);
  return urls;
}

// Fetch each URL (and the gstatic modules it imports in turn) into
// dest/__vendor/<host>/<path>, reusing cacheDir when the network is down.
async function vendorModules(dest, urls, { fetchImpl, cacheDir, log }) {
  const done = new Map(), failed = [];
  const queue = [...urls].sort();
  while (queue.length) {
    const url = queue.shift();
    if (done.has(url)) continue;
    const u = new URL(url);
    const rel = path.posix.join("__vendor", u.hostname, u.pathname);
    const cached = cacheDir ? path.join(cacheDir, u.hostname, u.pathname) : null;
    let buf = null, from = "network";
    try {
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      buf = Buffer.from(await r.arrayBuffer());
      if (cached) { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, buf); }
    } catch (e) {
      if (cached && fs.existsSync(cached)) { buf = fs.readFileSync(cached); from = "cache"; }
      else { failed.push({ url, error: String((e && e.message) || e) }); done.set(url, null); continue; }
    }
    fs.mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), buf);
    done.set(url, { url, path: rel, bytes: buf.length, sha256: sha256(buf), from });
    for (const m of buf.toString("utf8").match(VENDOR_URL_RE) || []) if (!done.has(m)) queue.push(m);
    if (log) log("  vendored " + url + " (" + from + ")");
  }
  return { vendored: [...done.values()].filter(Boolean), failed };
}

export async function syncWeb(opts = {}) {
  const src = path.resolve(opts.src || process.env.DARKNODE_WEB || path.join(APP_ROOT, "..", "darknode-web", "public"));
  const dest = path.resolve(opts.dest || path.join(APP_ROOT, "web"));
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const log = opts.log || (() => {});
  if (!fs.existsSync(path.join(src, "index.html"))) throw new Error("not a darknode-web public/ directory: " + src);
  if (path.relative(src, dest) === "" || !path.relative(src, dest).startsWith("..")) throw new Error("destination must not be inside the source: " + dest);

  const repoRoot = git(src, ["rev-parse", "--show-toplevel"]) || path.dirname(src);
  const hosting = readHosting(repoRoot) || { headers: [], rewrites: [{ source: "**", destination: "/index.html" }], ignore: [] };

  // Only ever wipe a directory this script produced (it carries .source.json).
  if (fs.existsSync(dest) && fs.readdirSync(dest).length && !fs.existsSync(path.join(dest, ".source.json"))) {
    throw new Error("refusing to overwrite a non-empty directory that sync-web did not create: " + dest);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  const copied = copyTree(src, dest, { maxBytes, isIgnored: ignoreMatcher(hosting.ignore) });

  let vend = { vendored: [], failed: [] };
  if (opts.vendor !== false) {
    vend = await vendorModules(dest, scanVendorUrls(dest), {
      fetchImpl: opts.fetchImpl || globalThis.fetch,
      cacheDir: opts.cacheDir === undefined ? path.join(APP_ROOT, ".cache", "web-vendor") : opts.cacheDir,
      log,
    });
  }

  const relSrc = path.relative(repoRoot, src).split(path.sep).join("/") || ".";
  const dirty = git(repoRoot, ["status", "--porcelain", "--", relSrc]);
  const remote = git(repoRoot, ["remote", "get-url", "origin"]);
  const source = {
    // Repo name + credential-free remote only; no local filesystem paths ship in the app.
    repo: path.basename(repoRoot),
    remote: remote ? remote.replace(/\/\/[^/@]*@/, "//") : null,
    path: relSrc,
    commit: git(repoRoot, ["rev-parse", "HEAD"]),
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: dirty === null ? null : dirty.length > 0,
  };
  const meta = {
    source,
    syncedAt: new Date().toISOString(),
    files: copied.files,
    bytes: copied.bytes,
    maxFileBytes: maxBytes,
    excluded: copied.excluded,
    vendored: vend.vendored,
    vendorFailed: vend.failed,
  };
  fs.writeFileSync(path.join(dest, ".hosting.json"), JSON.stringify({ headers: hosting.headers, rewrites: hosting.rewrites }, null, 2));
  fs.writeFileSync(path.join(dest, ".source.json"), JSON.stringify(meta, null, 2));
  return meta;
}

function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }

async function main(argv) {
  const opts = { log: (s) => console.log(s) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-vendor") opts.vendor = false;
    else if (a === "--max-mb") opts.maxBytes = Number(argv[++i]) * 1048576;
    else if (a === "--dest") opts.dest = argv[++i];
    else if (!a.startsWith("--")) opts.src = a;
  }
  const src = path.resolve(opts.src || process.env.DARKNODE_WEB || path.join(APP_ROOT, "..", "darknode-web", "public"));
  const dest = path.resolve(opts.dest || path.join(APP_ROOT, "web"));
  if (!fs.existsSync(path.join(src, "index.html"))) {
    // Building the app without the web repo next to it: keep an existing bundle.
    if (fs.existsSync(path.join(dest, ".source.json"))) {
      console.warn("[sync-web] website source not found at " + src + "; keeping the existing web/ bundle.");
      return;
    }
    console.error("[sync-web] website source not found at " + src + ". Pass the path to darknode-web/public or set DARKNODE_WEB.");
    process.exit(1);
  }
  const t0 = Date.now();
  const meta = await syncWeb(opts);
  console.log(`[sync-web] ${meta.files} files, ${mb(meta.bytes)} from ${meta.source.repo} @ ${(meta.source.commit || "?").slice(0, 8)}${meta.source.dirty ? " (dirty)" : ""} in ${Date.now() - t0} ms`);
  for (const x of meta.excluded) console.log(`[sync-web] excluded ${x.path} - ${x.reason} (${mb(x.bytes)})`);
  for (const f of meta.vendorFailed) console.warn(`[sync-web] WARNING could not vendor ${f.url}: ${f.error} (the console will need the network to boot)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error("[sync-web] " + ((e && e.stack) || e)); process.exit(1); });
}
