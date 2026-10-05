"use strict";
// Darknode scope enforcement glue — DA-009 (S0).
//
// Holds the authorization-record store (persisted to .nexus/scope.json), logs
// every decision (created/rejected/permitted/refused/revoked) into the
// hash-chained, tamper-evident audit trail (.nexus/audit.jsonl via lib/policy
// auditLog), and exposes enforce(kind, target) for the IPC handlers to call
// immediately before an active action. Records are mutated ONLY through
// addAuthorization()/revoke(); the enforce() path never writes a record, so no
// tool result or model output can author its own authorization.
//
// Verified by test/scope/enforce.test.mjs.

const fs = require("fs"), path = require("path");
const { authorize, validateRecord } = require("./authz");
const { auditLog } = require("../policy");

class ScopeEnforcer {
  constructor(cwd) { this.cwd = cwd; this.records = this._load(); }

  _file() { return path.join(this.cwd, ".nexus", "scope.json"); }
  _load() { try { return (JSON.parse(fs.readFileSync(this._file(), "utf8")).records) || []; } catch (_) { return []; } }
  _save() {
    try { fs.mkdirSync(path.join(this.cwd, ".nexus"), { recursive: true }); fs.writeFileSync(this._file(), JSON.stringify({ records: this.records }, null, 2)); return true; }
    catch (_) { return false; }
  }

  // Create an authorization record from explicit, attested input. Rejected input
  // is logged and NOT stored.
  addAuthorization(input) {
    const v = validateRecord(input);
    if (!v.ok) { auditLog(this.cwd, { event: "scope.authorize", decision: "rejected", reason: v.error }); return { ok: false, error: v.error }; }
    this.records.push(v.record); this._save();
    auditLog(this.cwd, { event: "scope.authorize", decision: "created", id: v.record.id, targets: v.record.targets, activityClasses: v.record.activityClasses, from: v.record.from, to: v.record.to, attestedBy: v.record.attestedBy });
    return { ok: true, record: v.record };
  }

  list() { return this.records.slice(); }

  revoke(id) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    this._save();
    const removed = before - this.records.length;
    auditLog(this.cwd, { event: "scope.revoke", id, removed });
    return { ok: true, removed };
  }

  // Non-logging check for UI hinting (whether to prompt for authorization). The
  // real gate is enforce(), called inside the action handler.
  preview(kind, target, opts) { return authorize({ kind, target }, this.records, opts || {}); }

  // The execution-layer gate. Logs the decision and returns { allowed, reason }.
  enforce(kind, target, opts) {
    const d = authorize({ kind, target }, this.records, opts || {});
    auditLog(this.cwd, {
      event: "scope.decision", kind, class: d.class, target: d.target,
      decision: d.allowed ? "permitted" : "refused",
      basis: d.allowed ? d.basis : undefined,
      reason: d.allowed ? undefined : d.reason,
    });
    return d;
  }
}

module.exports = { ScopeEnforcer };
