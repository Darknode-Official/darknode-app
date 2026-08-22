"use strict";
// Compliance export bundle — a single, verifiable artifact for SOC2 / audit review.
// It ties together the three governance streams for a project:
//   • audit.jsonl  — WHAT the agent did (hash-chained action trail)
//   • usage.jsonl  — WHAT it cost (attributed cost ledger)
//   • policy.json  — the guardrails in force
// plus a manifest of SHA-256 file digests, the audit-chain verification result, an
// integrity hash over the whole bundle, and (when a signing key is provided) an
// HMAC-SHA256 signature so a reviewer can prove the bundle was not altered.
// buildBundle takes an injectable `now`, so it is deterministic and unit-tested.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { loadUsage, summarize } = require("./usage");
const { auditVerify } = require("./policy");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readSafe = (p) => { try { return fs.readFileSync(p); } catch (_) { return null; } };
const lineCount = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim()).length;

// buildBundle(cwd, { operator, team, now, signingKey }) -> the bundle object.
function buildBundle(cwd, opts) {
  opts = opts || {};
  const nx = path.join(cwd, ".nexus");
  const auditBuf = readSafe(path.join(nx, "audit.jsonl"));
  const usageBuf = readSafe(path.join(nx, "usage.jsonl"));
  const policyBuf = readSafe(path.join(nx, "policy.json"));
  const av = auditVerify(cwd);
  const manifest = {};
  if (auditBuf) manifest["audit.jsonl"] = { bytes: auditBuf.length, lines: lineCount(auditBuf), sha256: sha256(auditBuf) };
  if (usageBuf) manifest["usage.jsonl"] = { bytes: usageBuf.length, lines: lineCount(usageBuf), sha256: sha256(usageBuf) };
  if (policyBuf) manifest["policy.json"] = { bytes: policyBuf.length, sha256: sha256(policyBuf) };

  const bundle = {
    kind: "sentinel.compliance.bundle",
    version: 1,
    generatedAt: opts.now || new Date().toISOString(),
    project: path.basename(cwd),
    operator: opts.operator || null,
    team: opts.team || null,
    auditChain: { present: !!auditBuf, verified: !!av.ok, records: av.count || 0, reason: av.ok ? null : (av.reason || null) },
    usage: summarize(loadUsage(cwd)),
    manifest,
  };
  // integrity hash + optional signature are computed over the bundle WITHOUT them
  const canon = JSON.stringify(bundle);
  bundle.integrity = { algo: "sha256", hash: sha256(canon) };
  if (opts.signingKey) bundle.signature = { algo: "hmac-sha256", value: crypto.createHmac("sha256", opts.signingKey).update(canon).digest("hex") };
  return bundle;
}

// verifyBundle(bundle, signingKey?) -> { hashOk, sigOk }. sigOk is null when the
// bundle is unsigned or no key is supplied.
function verifyBundle(bundle, signingKey) {
  const b = Object.assign({}, bundle);
  const integ = b.integrity, sig = b.signature;
  delete b.integrity; delete b.signature;
  const canon = JSON.stringify(b);
  const hashOk = !!(integ && integ.hash === sha256(canon));
  let sigOk = null;
  if (sig && signingKey) sigOk = sig.value === crypto.createHmac("sha256", signingKey).update(canon).digest("hex");
  return { hashOk, sigOk };
}

// renderBundleMd(bundle) -> a human-readable Markdown compliance report.
function renderBundleMd(b) {
  const u = b.usage || {};
  const L = [];
  L.push("# Sentinel compliance report — " + b.project);
  L.push("");
  L.push("- **Generated:** " + b.generatedAt);
  L.push("- **Operator:** " + (b.operator || "(unattributed)") + (b.team ? "  ·  **Team:** " + b.team : ""));
  L.push("- **Audit chain:** " + (!b.auditChain.present ? "none" : b.auditChain.verified ? "VERIFIED (" + b.auditChain.records + " records)" : "BROKEN — " + b.auditChain.reason));
  L.push("- **Integrity:** " + b.integrity.algo + " " + b.integrity.hash);
  if (b.signature) L.push("- **Signature:** " + b.signature.algo + " " + b.signature.value);
  L.push("");
  L.push("## Usage");
  L.push("- Turns: " + (u.turns || 0) + (u.interrupted ? " (" + u.interrupted + " interrupted)" : ""));
  L.push("- Tokens: " + (u.inTok || 0) + " in / " + (u.outTok || 0) + " out");
  L.push("- Cost: $" + (Math.round((u.cost || 0) * 1e4) / 1e4).toFixed(4));
  L.push("- Activity: " + (u.files || 0) + " file changes, " + (u.commands || 0) + " commands");
  L.push("");
  L.push("## Manifest (SHA-256)");
  const keys = Object.keys(b.manifest);
  if (!keys.length) L.push("_(no governance files found in .nexus/)_");
  for (const k of keys) L.push("- `" + k + "` — " + b.manifest[k].sha256 + (b.manifest[k].lines != null ? "  (" + b.manifest[k].lines + " lines)" : ""));
  L.push("");
  L.push("_Verify with: `sentinel compliance verify <file>`_");
  return L.join("\n");
}

module.exports = { buildBundle, verifyBundle, renderBundleMd, sha256 };
