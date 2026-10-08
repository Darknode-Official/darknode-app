"use strict";
// Darknode secret redaction — DA-008 (S0).
//
// A single scrubber applied across every output channel that can carry a value
// off the machine or into durable storage: main-process logs, agent-exec
// transcripts, the usage ledger, the signed compliance bundle, and IPC error
// strings. Two layers:
//   1) SHAPE rules — token formats recognizable on sight (bearer tokens, vendor
//      key prefixes, JWTs, AWS keys, PEM private keys, high-entropy values next
//      to a secret-ish name).
//   2) REGISTERED LITERALS — exact strings the app actually holds (every value
//      written to the vault registers itself here), so even an unusual token the
//      shape rules miss is still scrubbed wherever it appears.
//
// Pure + deterministic + idempotent. Verified by test/secret/redact.test.mjs.
//
// Design limit: shape rules are deliberately anchored (prefix or secret-keyword
// context) so ordinary prose and legitimate hashes are not mangled. A novel
// secret with no recognizable shape is caught only once it is a registered
// literal — which is why the vault registers every stored value.

const MASK = "[REDACTED]";

// Exact strings to always scrub (vault values, known credentials). A Set of the
// raw strings; longest-first application avoids partial leftovers.
const _literals = new Set();

function registerSecret(value) {
  const s = String(value == null ? "" : value);
  if (s.length >= 4) _literals.add(s); // ignore trivially short values
  return _literals.size;
}
function unregisterSecret(value) { return _literals.delete(String(value)); }
function clearSecrets() { _literals.clear(); }
function registeredCount() { return _literals.size; }

// escape a literal for use inside a RegExp
function _esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Shape rules. Each is [name, RegExp-with-global-flag, replacement|fn].
// Replacements keep a short, non-sensitive label so output stays readable.
const RULES = [
  // PEM private key blocks (any type) -> collapse the whole block
  ["pem-private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  // Anthropic (check before generic sk-)
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/g, MASK],
  // OpenAI-style secret keys
  ["openai-key", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, MASK],
  // GitHub tokens (fine-grained + classic prefixes)
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, MASK],
  // Google API keys
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  // Slack tokens
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, MASK],
  // AWS access key id
  ["aws-access-key-id", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g, MASK],
  // JWT (three base64url segments) — unverified shape
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, MASK],
  // Authorization / Bearer header values
  ["authorization-header", /\b(Authorization\s*[:=]\s*)(?:Bearer\s+|Basic\s+|Token\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, "$1" + MASK],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer " + MASK],
  // x-apikey style headers
  ["apikey-header", /\b(x-?api-?key\s*[:=]\s*)[A-Za-z0-9._-]{8,}/gi, "$1" + MASK],
  // generic "<secret-ish name> = <value>" assignment (json/env/code)
  ["named-secret-assignment", /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|passphrase|client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'{}][^\s"']{5,})(["']?)/gi,
    (_m, name, mid, _val, end) => name + mid + MASK + end],
];

// Replace every registered literal in a string (longest first).
function _scrubLiterals(str) {
  if (!_literals.size) return str;
  const arr = Array.from(_literals).sort((a, b) => b.length - a.length);
  let out = str;
  for (const lit of arr) { if (out.indexOf(lit) !== -1) out = out.split(lit).join(MASK); }
  return out;
}

// Scrub a single string: literals first (exact), then shape rules.
function redactString(str, opts) {
  opts = opts || {};
  if (typeof str !== "string" || !str) return str;
  let out = _scrubLiterals(str);
  if (Array.isArray(opts.extra)) for (const e of opts.extra) { const v = String(e); if (v.length >= 4 && out.indexOf(v) !== -1) out = out.split(v).join(MASK); }
  for (const [, re, rep] of RULES) { re.lastIndex = 0; out = out.replace(re, rep); }
  return out;
}

// Deep-scrub any value. Strings are redacted; objects/arrays walked. Keys whose
// name looks secret-ish have their string value fully masked regardless of shape.
const _SECRET_KEY = /(api[_-]?key|secret|token|passwd|password|passphrase|private[_-]?key|credential|authorization)/i;
function redact(input, opts) {
  opts = opts || {};
  const seen = opts._seen || new WeakSet();
  if (typeof input === "string") return redactString(input, opts);
  if (input == null || typeof input !== "object") return input;
  if (seen.has(input)) return input;
  seen.add(input);
  const childOpts = Object.assign({}, opts, { _seen: seen });
  if (Array.isArray(input)) return input.map((v) => redact(v, childOpts));
  const out = {};
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (_SECRET_KEY.test(k) && v != null && typeof v !== "object") out[k] = (typeof v === "string" && v.length < 4) ? v : MASK;
    else out[k] = redact(v, childOpts);
  }
  return out;
}

// Convenience: true if a string still contains something the shape rules flag.
function containsSecret(str) {
  if (typeof str !== "string") return false;
  for (const [, re] of RULES) { re.lastIndex = 0; if (re.test(str)) return true; }
  for (const lit of _literals) if (str.indexOf(lit) !== -1) return true;
  return false;
}

module.exports = {
  MASK, RULES,
  registerSecret, unregisterSecret, clearSecrets, registeredCount,
  redactString, redact, containsSecret,
};
