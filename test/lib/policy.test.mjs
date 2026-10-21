// Unit tests for lib/policy.js — the protected-path guard, denied-command gate,
// and the tamper-evident hash-chained audit trail (previously only exercised
// indirectly through scope/enforce).
import { test, group, assert } from "../harness.mjs";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import P from "../../lib/policy.js";

const { POLICY_DEFAULTS, globToRe, pathMatchesAny, policyCheck, auditLog, auditVerify } = P;

group("policy: path globs", () => {
  test("globToRe anchors and distinguishes ** / * / ?", () => {
    assert.ok(globToRe("**/.env").test("a/b/.env"));
    assert.ok(globToRe("*.pem").test("server.pem"));
    assert.notOk(globToRe("*.pem").test("server.pem.bak"));
    assert.ok(globToRe("id_rsa?").test("id_rsax"));
  });
  test("pathMatchesAny matches full path or basename, backslashes normalised", () => {
    assert.ok(pathMatchesAny("config\\.env", POLICY_DEFAULTS.protectedPaths));
    assert.ok(pathMatchesAny("app/secrets/db.txt", ["**/secrets/**"]));
    assert.notOk(pathMatchesAny("notes.md", POLICY_DEFAULTS.protectedPaths));
  });
  test("a malformed glob is swallowed, not thrown", () => {
    assert.notOk(pathMatchesAny("x", ["["]));
  });
});

group("policy: policyCheck", () => {
  const pol = Object.assign({}, POLICY_DEFAULTS);
  test("writing a protected path is denied", () => {
    assert.equal(policyCheck(pol, { type: "write", path: ".env" }).allow, false);
  });
  test("a denied-command regex blocks a run", () => {
    const r = policyCheck(Object.assign({}, pol, { deniedCommands: ["rm\\s+-rf\\s+/"] }), { type: "run", command: "rm -rf /" });
    assert.equal(r.allow, false);
  });
  test("an invalid denied-command regex is ignored, not fatal", () => {
    assert.equal(policyCheck(Object.assign({}, pol, { deniedCommands: ["("] }), { type: "run", command: "ls" }).allow, true);
  });
  test("fetch is denied only when allowNetwork is false", () => {
    assert.equal(policyCheck(Object.assign({}, pol, { allowNetwork: false }), { type: "fetch" }).allow, false);
    assert.equal(policyCheck(Object.assign({}, pol, { allowNetwork: true }), { type: "fetch" }).allow, true);
  });
  test("an ordinary action is allowed", () => {
    assert.equal(policyCheck(pol, { type: "run", command: "ls -la" }).allow, true);
  });
});

group("policy: tamper-evident audit trail", () => {
  test("auditVerify confirms a clean hash chain and detects an edited entry", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "dn-policy-"));
    try {
      auditLog(dir, { action: "run", command: "ls" });
      auditLog(dir, { action: "write", path: "a.txt" });
      const v1 = auditVerify(dir);
      assert.ok(v1.ok, "a clean chain verifies");
      assert.equal(v1.count, 2);
      const f = join(dir, ".nexus", "audit.jsonl");
      const lines = fs.readFileSync(f, "utf8").trim().split("\n");
      const rec0 = JSON.parse(lines[0]); rec0.command = "rm -rf /"; lines[0] = JSON.stringify(rec0);
      fs.writeFileSync(f, lines.join("\n") + "\n");
      assert.notOk(auditVerify(dir).ok, "an edited entry breaks the chain");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("auditVerify of a missing log is ok+empty", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "dn-policy-"));
    try { const v = auditVerify(dir); assert.ok(v.ok); assert.ok(v.empty); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
