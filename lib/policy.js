"use strict";
// Enterprise guardrails engine — pure policy evaluation + a tamper-evident audit
// trail. Dependency-free (fs/crypto only); the sentinelHome-aware two-tier merge
// (org floor + local) lives in sentinel.js as loadPolicy(), which uses these.

const POLICY_DEFAULTS = {
  protectedPaths: [".env", ".env.*", "**/.env", "**/.env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "**/.ssh/**", "**/secrets/**", "**/.git/**", "**/credentials*", "**/*.pfx"],
  deniedCommands: [],          // extra regex strings, on top of the built-in destructive-command guard
  requireApprovalPaths: [],    // globs that may only be changed after explicit approval
  maxFilesPerTurn: 0,          // 0 = unlimited
  blockSecrets: true,          // refuse to write a file that contains a detected secret
  allowNetwork: true,          // allow the http_fetch tool
  audit: true,                 // append every enforced action to .nexus/audit.jsonl
};
function globToRe(g) { let re = ""; for (let i = 0; i < g.length; i++) { const c = g[i]; if (c === "*") { if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; } else re += "[^/]*"; } else if (c === "?") re += "[^/]"; else if (".+^${}()|[]\\".includes(c)) re += "\\" + c; else re += c; } return new RegExp("^" + re + "$"); }
function pathMatchesAny(rel, globs) { const p = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, ""); const base = p.split("/").pop(); return (globs || []).some((g) => { try { const re = globToRe(g); return re.test(p) || re.test(base); } catch (_) { return false; } }); }
// action = { type: "write"|"edit"|"delete"|"move"|"run"|"fetch", path?, command? } -> { allow, reason?, approval? }
function policyCheck(policy, action) {
  const t = action.type;
  if ((t === "write" || t === "edit" || t === "delete" || t === "move") && action.path) {
    if (pathMatchesAny(action.path, policy.protectedPaths)) return { allow: false, reason: "protected path: " + action.path };
    if (pathMatchesAny(action.path, policy.requireApprovalPaths)) return { allow: false, reason: "requires approval: " + action.path, approval: true };
  }
  if (t === "run" && action.command) for (const rs of (policy.deniedCommands || [])) { try { if (new RegExp(rs).test(action.command)) return { allow: false, reason: "denied command: /" + rs + "/" }; } catch (_) {} }
  if (t === "fetch" && !policy.allowNetwork) return { allow: false, reason: "network disabled by policy" };
  return { allow: true };
}
// Tamper-evident audit trail: each record carries seq + prevHash and a sha256 over
// itself, forming a hash chain. Deleting, reordering or editing any past entry breaks
// the chain, which `auditVerify` detects — compliance-grade provenance.
function auditLog(cwd, entry) {
  try {
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    fs.mkdirSync(path.join(cwd, ".nexus"), { recursive: true });
    const file = path.join(cwd, ".nexus", "audit.jsonl");
    let prevHash = "0".repeat(64), seq = 0;
    try { const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean); if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); prevHash = last.hash || prevHash; seq = (last.seq || 0) + 1; } } catch (_) {}
    const rec = Object.assign({ ts: new Date().toISOString(), seq }, entry, { prevHash });
    rec.hash = crypto.createHash("sha256").update(JSON.stringify(rec)).digest("hex"); // chains prevHash (a field of rec)
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch (_) {}
}
function auditVerify(cwd) {
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  let lines; try { lines = fs.readFileSync(path.join(cwd, ".nexus", "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean); } catch (_) { return { ok: true, count: 0, empty: true }; }
  let prevHash = "0".repeat(64);
  for (let i = 0; i < lines.length; i++) {
    let rec; try { rec = JSON.parse(lines[i]); } catch (_) { return { ok: false, count: lines.length, badLine: i + 1, reason: "unparseable record" }; }
    if (rec.prevHash !== prevHash) return { ok: false, count: lines.length, badLine: i + 1, reason: "chain break (prevHash mismatch — an entry was removed or reordered)" };
    const stored = rec.hash, copy = Object.assign({}, rec); delete copy.hash;
    if (crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex") !== stored) return { ok: false, count: lines.length, badLine: i + 1, reason: "tampered (hash mismatch — an entry was edited)" };
    prevHash = stored;
  }
  return { ok: true, count: lines.length };
}

module.exports = { POLICY_DEFAULTS, globToRe, pathMatchesAny, policyCheck, auditLog, auditVerify };
