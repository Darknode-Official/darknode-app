"use strict";
// Operator + team identity for attribution (chargeback) and audit provenance.
// Resolution order, highest priority first:
//   1. Environment — SENTINEL_OPERATOR / SENTINEL_TEAM. This is the SSO / IdP hook:
//      an enterprise provisions these from its identity provider (an OIDC/SAML
//      session, a login wrapper, or CI secrets) so every turn is attributed to a
//      real person and team without the CLI implementing a browser SSO handshake.
//   2. Local config — .nexus/identity.json { "operator": "...", "team": "..." }.
//   3. Fallback — the OS username, so attribution is never blank.
// Pure + injectable (pass env/cwd) so it is unit-tested.
const os = require("os"), fs = require("fs"), path = require("path");

function resolveOperator(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  let operator = (env.SENTINEL_OPERATOR || env.SENTINEL_USER || "").trim();
  let team = (env.SENTINEL_TEAM || "").trim();
  let source = operator ? "sso-env" : "";
  if (!operator || !team) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".nexus", "identity.json"), "utf8"));
      if (!operator && cfg && cfg.operator) { operator = String(cfg.operator).trim(); source = source || "config"; }
      if (!team && cfg && cfg.team) team = String(cfg.team).trim();
    } catch (_) {}
  }
  if (!operator) { try { operator = (os.userInfo().username || "").trim(); } catch (_) {} source = source || "os"; }
  if (!operator) { operator = "unknown"; source = source || "os"; }
  return { operator, team: team || "", source: source || "os" };
}

module.exports = { resolveOperator };
