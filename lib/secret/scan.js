"use strict";
// Darknode secret scanner — DA-008 (S0).
//
// Scans text / files / a source tree for hardcoded credentials, reusing the
// shape rules in redact.js so "what we scrub at runtime" and "what we refuse to
// ship" never drift apart. Intended to run over the source tree and over a built
// artifact before packaging (scripts/scan-secrets.mjs), failing on any finding
// that is not explicitly allow-listed.
//
// Allow-listing: the known, deliberately-shipped free-tier keys (e.g. the
// ex-hardcoded VirusTotal / Shodan keys) are suppressed via an allow list of
// substrings/regex sources loaded from security/secret-allowlist.json, so the
// scanner does not nag about them while still catching anything NEW.
//
// Findings never include the full secret: the matched span is masked to
// first4…last2 so a scan report is itself safe to store.
//
// Verified by test/secret/scan.test.mjs.

const fs = require("fs"), path = require("path");
const { RULES } = require("./redact");

// Rules that are too broad to fail a build on their own (they exist to scrub at
// runtime but produce false positives in source, e.g. a doc showing `Bearer X`).
// Scanning uses only the high-precision, prefix-anchored rules by default.
const SCAN_RULE_NAMES = new Set([
  "pem-private-key", "anthropic-key", "openai-key", "github-token",
  "google-api-key", "slack-token", "aws-access-key-id", "jwt",
]);

function _mask(s) { s = String(s); return s.length <= 8 ? "***" : s.slice(0, 4) + "…" + s.slice(-2) + " (" + s.length + " chars)"; }

function _allowed(match, allow) {
  if (!allow || !allow.length) return false;
  for (const a of allow) {
    if (a instanceof RegExp) { a.lastIndex = 0; if (a.test(match)) return true; }
    else if (typeof a === "string" && a && match.indexOf(a) !== -1) return true;
  }
  return false;
}

// scanText(text, { allow, rules }) -> [{ rule, masked, index, line }]
function scanText(text, opts) {
  opts = opts || {};
  text = String(text == null ? "" : text);
  const allow = opts.allow || [];
  const ruleFilter = opts.rules || SCAN_RULE_NAMES;
  const findings = [];
  // precompute line starts for line numbers
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (idx) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
  for (const [name, re] of RULES) {
    if (ruleFilter && !ruleFilter.has(name)) continue;
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(text)) !== null) {
      const hit = m[0];
      if (m.index === g.lastIndex) g.lastIndex++; // zero-width guard
      if (_allowed(hit, allow)) continue;
      findings.push({ rule: name, masked: _mask(hit), index: m.index, line: lineAt(m.index) });
    }
  }
  return findings;
}

const DEFAULT_IGNORE_DIRS = new Set([".git", "node_modules", "dist", "out", "build", ".nexus", "coverage"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".so", ".dylib", ".node", ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".AppImage", ".asar", ".bin"]);

function _loadAllowlist(root) {
  const out = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "security", "secret-allowlist.json"), "utf8"));
    for (const s of (raw.substrings || [])) out.push(String(s));
    for (const r of (raw.patterns || [])) { try { out.push(new RegExp(r)); } catch (_) {} }
  } catch (_) {}
  return out;
}

// scanTree(root, { allow, ignoreDirs, maxBytes }) -> { files, findings:[{file,...}] }
function scanTree(root, opts) {
  opts = opts || {};
  const allow = (opts.allow || []).concat(_loadAllowlist(root));
  const ignoreDirs = opts.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
  const findings = [];
  let files = 0;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!ignoreDirs.has(ent.name)) walk(full); continue; }
      if (!ent.isFile()) continue;
      if (BINARY_EXT.has(path.extname(ent.name))) continue;
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.size > maxBytes) continue;
      let text; try { text = fs.readFileSync(full, "utf8"); } catch (_) { continue; }
      if (text.indexOf("\u0000") !== -1) continue; // binary
      files++;
      for (const f of scanText(text, { allow })) findings.push(Object.assign({ file: path.relative(root, full) }, f));
    }
  };
  walk(root);
  return { files, findings };
}

module.exports = { scanText, scanTree, SCAN_RULE_NAMES, _mask };
