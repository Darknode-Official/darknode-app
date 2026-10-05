"use strict";
// Darknode scope authorization — DA-009 (S0).
//
// A live/active capability (port scan, content fuzz, subdomain enum, direct TLS
// connect, arbitrary HTTP to a target) is NOT actionable until an authorization
// record exists that covers (target, activity class, time window) and names an
// attesting party. This module is the PURE decision core; it is called by the
// execution layer immediately before the action (lib/scope/enforce.js), never by
// the UI.
//
// Scope cannot be widened by conversational instruction, by content read from a
// target/file/tool result, or by incremental creep, BECAUSE:
//   - authorize() reads ONLY the structured `records` store; it ignores every
//     other field on the action (no `override`, `instruction`, `authorizedBy`,
//     `because`, etc. on the action can grant access).
//   - records are created only through the explicit addAuthorization() path with
//     attested fields; nothing in the scan/fuzz executor can add a record, so a
//     tool result or model output can never author its own authorization.
//   - each action is evaluated independently; a prior permitted action never
//     broadens what a later one may do.
//
// Verified by test/scope/authz.test.mjs (incl. the red-team escape suite).

// Map an action kind to an activity class. Unknown kinds fail closed as "active".
const ACTIVITY = {
  scan: "active", fuzz: "active", subdomains: "active", tls: "active", http: "active",
  dns: "passive", whois: "passive", cve: "passive", netget: "passive",
  review: "review",
};
function classifyActivity(kind) {
  return ACTIVITY[String(kind || "").toLowerCase()] || "active";
}

// Canonical target id: lowercase host, scheme/port/path stripped, brackets off.
function normalizeTarget(hostOrUrl) {
  let s = String(hostOrUrl || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, "");        // scheme
  s = s.split("/")[0].split("?")[0];        // path/query
  const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);   // [ipv6] or [ipv6]:port
  if (br) return br[1];
  if (/^[^:]+:\d+$/.test(s)) return s.replace(/:\d+$/, "");  // host:port / ipv4:port (single colon)
  return s;                                  // bare ipv6 or plain host
}

// Does a record's target list cover this target?
//   "example.com"      -> exact host only
//   "*.example.com"    -> any subdomain (not the apex)
//   "10.0.0.5"         -> exact ip
// No implicit broadening: an apex entry does NOT cover its subdomains.
function targetCovered(record, target) {
  const t = normalizeTarget(target);
  if (!t) return false;
  for (const raw of (record && record.targets) || []) {
    const pat = normalizeTarget(String(raw).replace(/^\*\./, "WILDCARD."));
    if (String(raw).startsWith("*.")) {
      const suffix = pat.replace(/^wildcard\./, "");
      if (t !== suffix && t.endsWith("." + suffix)) return true;
    } else if (t === normalizeTarget(raw)) {
      return true;
    }
  }
  return false;
}

function recordActive(record, now) {
  const from = record.from ? Date.parse(record.from) : -Infinity;
  const to = record.to ? Date.parse(record.to) : Infinity;
  return now >= from && now <= to;
}

// Validate a would-be authorization record. Returns { ok, record } or { ok:false, error }.
// Requires: target identifiers, >=1 activity class, a time window, an attesting party.
function validateRecord(input) {
  const r = input || {};
  const targets = Array.isArray(r.targets) ? r.targets.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!targets.length) return { ok: false, error: "authorization needs at least one target identifier" };
  const classes = Array.isArray(r.activityClasses) ? r.activityClasses.map((x) => String(x).toLowerCase()) : [];
  const valid = classes.filter((c) => c === "active" || c === "passive" || c === "review");
  if (!valid.length) return { ok: false, error: "authorization needs at least one activity class (active/passive/review)" };
  if (!r.from || !r.to || isNaN(Date.parse(r.from)) || isNaN(Date.parse(r.to))) return { ok: false, error: "authorization needs a valid time window (from/to)" };
  if (Date.parse(r.to) <= Date.parse(r.from)) return { ok: false, error: "authorization window end must be after its start" };
  if (!r.attestedBy || !String(r.attestedBy).trim()) return { ok: false, error: "authorization needs an attesting party" };
  return { ok: true, record: {
    id: String(r.id || ("auth-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8))),
    targets, activityClasses: valid, from: r.from, to: r.to,
    attestedBy: String(r.attestedBy).trim(), note: r.note ? String(r.note).slice(0, 500) : "",
    createdAt: r.createdAt || new Date().toISOString(),
  } };
}

// The S0 decision. policy.requireRecordFor controls which classes demand a record;
// active ALWAYS requires one (fail-closed; a passed-in false is ignored).
const DEFAULT_POLICY = { requireRecordFor: { active: true, passive: false, review: false } };

function authorize(action, records, opts) {
  opts = opts || {};
  const now = opts.now == null ? Date.now() : opts.now;
  const policy = opts.policy || DEFAULT_POLICY;
  const cls = classifyActivity(action && action.kind);
  const target = normalizeTarget(action && action.target);
  const require = cls === "active" ? true : !!(policy.requireRecordFor && policy.requireRecordFor[cls]);

  if (!require) return { allowed: true, class: cls, target, basis: "class-not-gated" };
  if (!target) return { allowed: false, class: cls, target, reason: "no target supplied for an " + cls + " action" };

  const list = Array.isArray(records) ? records : [];
  for (const rec of list) {
    if (!rec || !Array.isArray(rec.activityClasses)) continue;
    if (!rec.activityClasses.includes(cls)) continue;   // class separation: no cross-grant
    if (!targetCovered(rec, target)) continue;
    if (!recordActive(rec, now)) continue;
    return { allowed: true, class: cls, target, basis: rec.id };
  }
  return { allowed: false, class: cls, target, reason: "no authorization record covers " + cls + " on " + target + " at this time" };
}

module.exports = { classifyActivity, normalizeTarget, targetCovered, validateRecord, authorize, ACTIVITY, DEFAULT_POLICY };
