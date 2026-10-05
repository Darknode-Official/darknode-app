// Scope enforcement glue tests (DA-009) — persistence + tamper-evident logging.
import { test, group, assert } from "../harness.mjs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeEnforcer } from "../../lib/scope/enforce.js";
import P from "../../lib/policy.js";

const { auditVerify } = P;

function freshCwd() { return mkdtempSync(join(tmpdir(), "dn-scope-")); }
const auth = { targets: ["example.com"], activityClasses: ["active"], from: "2026-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z", attestedBy: "owner" };

group("scope.enforce: gate + audit trail", () => {
  test("refuses an active action before any authorization and logs it", () => {
    const cwd = freshCwd();
    try {
      const e = new ScopeEnforcer(cwd);
      const d = e.enforce("scan", "example.com");
      assert.notOk(d.allowed);
      const log = readFileSync(join(cwd, ".nexus", "audit.jsonl"), "utf8");
      assert.ok(/"event":"scope.decision"/.test(log) && /"decision":"refused"/.test(log), "refusal must be logged");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("permits after an authorization is created; both are logged; chain verifies", () => {
    const cwd = freshCwd();
    try {
      const e = new ScopeEnforcer(cwd);
      const a = e.addAuthorization(auth);
      assert.ok(a.ok);
      const d = e.enforce("scan", "example.com");
      assert.ok(d.allowed);
      assert.equal(d.basis, a.record.id);
      const v = auditVerify(cwd);
      assert.ok(v.ok, "hash-chained audit trail must verify: " + JSON.stringify(v));
      assert.ok(v.count >= 2, "created-event + decision both logged");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("records persist across enforcer instances (reload)", () => {
    const cwd = freshCwd();
    try {
      new ScopeEnforcer(cwd).addAuthorization(auth);
      const e2 = new ScopeEnforcer(cwd);
      assert.equal(e2.list().length, 1);
      assert.ok(e2.enforce("scan", "example.com").allowed);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("revoke removes authorization; subsequent action is refused", () => {
    const cwd = freshCwd();
    try {
      const e = new ScopeEnforcer(cwd);
      const a = e.addAuthorization(auth);
      assert.ok(e.enforce("scan", "example.com").allowed);
      e.revoke(a.record.id);
      assert.notOk(e.enforce("scan", "example.com").allowed, "revoked scope must refuse");
      assert.ok(auditVerify(cwd).ok);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("a rejected (incomplete) authorization is not stored", () => {
    const cwd = freshCwd();
    try {
      const e = new ScopeEnforcer(cwd);
      const r = e.addAuthorization({ targets: ["x.com"], activityClasses: ["active"], attestedBy: "o" }); // no window
      assert.notOk(r.ok);
      assert.equal(e.list().length, 0);
      assert.notOk(existsSync(join(cwd, ".nexus", "scope.json")) && JSON.parse(readFileSync(join(cwd, ".nexus", "scope.json"), "utf8")).records.length, "rejected record must not persist");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("tampering with the audit trail is detected", () => {
    const cwd = freshCwd();
    try {
      const e = new ScopeEnforcer(cwd);
      e.addAuthorization(auth); e.enforce("scan", "example.com");
      const file = join(cwd, ".nexus", "audit.jsonl");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      // edit the first record's content without recomputing the chain
      const first = JSON.parse(lines[0]); first.attestedBy = "attacker";
      lines[0] = JSON.stringify(first);
      writeFileSync(file, lines.join("\n") + "\n");
      assert.notOk(auditVerify(cwd).ok, "edited audit entry must fail verification");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
