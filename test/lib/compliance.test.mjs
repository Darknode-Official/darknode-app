// Unit tests for lib/compliance.js — the SOC2/audit export bundle. The header
// states buildBundle takes an injectable `now` "so it is deterministic and
// unit-tested"; this is that test. Runs against a real temp .nexus directory.
import { test, group, assert } from "../harness.mjs";
import { join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import Comp from "../../lib/compliance.js";

const { buildBundle, verifyBundle, renderBundleMd, sha256 } = Comp;

function tmpProjectWithNexus() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "dn-comp-"));
  const nx = join(dir, ".nexus");
  fs.mkdirSync(nx, { recursive: true });
  fs.writeFileSync(join(nx, "usage.jsonl"),
    JSON.stringify({ ts: "2026-06-01T00:00:00Z", engine: "claude", inTok: 100, outTok: 50, cost: 0.01, files: 1, commands: 2 }) + "\n" +
    JSON.stringify({ ts: "2026-06-02T00:00:00Z", engine: "claude", inTok: 200, outTok: 80, cost: 0.02 }) + "\n");
  fs.writeFileSync(join(nx, "policy.json"), JSON.stringify({ allowNetwork: true, protectedPaths: [] }));
  return { dir, nx, clean: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

const NOW = "2026-06-15T12:00:00.000Z";

group("compliance: buildBundle", () => {
  test("deterministic with injected now (no signature)", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b1 = buildBundle(dir, { now: NOW, operator: "alice", team: "red" });
      const b2 = buildBundle(dir, { now: NOW, operator: "alice", team: "red" });
      assert.equal(b1.integrity.hash, b2.integrity.hash);
      assert.equal(b1.generatedAt, NOW);
      assert.equal(b1.operator, "alice");
      assert.equal(b1.kind, "darknode.compliance.bundle");
    } finally { clean(); }
  });
  test("manifest hashes the real files and counts usage lines", () => {
    const { dir, nx, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      assert.equal(b.manifest["usage.jsonl"].lines, 2);
      assert.equal(b.manifest["usage.jsonl"].sha256, sha256(fs.readFileSync(join(nx, "usage.jsonl"))));
      assert.ok(b.manifest["policy.json"]);
    } finally { clean(); }
  });
  test("usage summary rolled into the bundle", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      assert.equal(b.usage.turns, 2);
      assert.close(b.usage.cost, 0.03, 1e-9);
    } finally { clean(); }
  });
  test("audit chain reported absent when there is no audit.jsonl", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      assert.equal(b.auditChain.present, false);
    } finally { clean(); }
  });
});

group("compliance: verifyBundle", () => {
  test("hashOk true for an untouched bundle", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      const v = verifyBundle(b);
      assert.equal(v.hashOk, true);
      assert.equal(v.sigOk, null); // unsigned
    } finally { clean(); }
  });
  test("hashOk false when the bundle is tampered with", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      b.operator = "mallory"; // alter a field after the integrity hash was taken
      assert.equal(verifyBundle(b).hashOk, false);
    } finally { clean(); }
  });
  test("signed bundle verifies with the right key and fails with the wrong one", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW, signingKey: "s3cret" });
      assert.ok(b.signature && b.signature.algo === "hmac-sha256");
      assert.equal(verifyBundle(b, "s3cret").sigOk, true);
      assert.equal(verifyBundle(b, "wrong").sigOk, false);
      assert.equal(verifyBundle(b, "s3cret").hashOk, true);
    } finally { clean(); }
  });
  test("signature value matches an independent HMAC computation", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW, signingKey: "k" });
      const copy = Object.assign({}, b); delete copy.integrity; delete copy.signature;
      const expect = crypto.createHmac("sha256", "k").update(JSON.stringify(copy)).digest("hex");
      assert.equal(b.signature.value, expect);
    } finally { clean(); }
  });
});

group("compliance: renderBundleMd", () => {
  test("renders operator, integrity, usage, and manifest", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const md = renderBundleMd(buildBundle(dir, { now: NOW, operator: "alice", team: "red" }));
      assert.ok(md.includes("# Darknode compliance report"));
      assert.ok(md.includes("alice"));
      assert.ok(md.includes("Red".toLowerCase()) || md.includes("red"));
      assert.ok(md.includes("## Usage"));
      assert.ok(md.includes("## Manifest (SHA-256)"));
      assert.ok(md.includes("usage.jsonl"));
    } finally { clean(); }
  });
  test("handles a project with no governance files", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "dn-comp-empty-"));
    try {
      const md = renderBundleMd(buildBundle(dir, { now: NOW }));
      assert.ok(md.includes("no governance files"));
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  });
});

group("compliance: verifyBundle robustness", () => {
  test("a hash of wrong length or non-hex is rejected, not thrown", () => {
    const { dir, clean } = tmpProjectWithNexus();
    try {
      const b = buildBundle(dir, { now: NOW });
      const short = JSON.parse(JSON.stringify(b)); short.integrity.hash = "abcd";
      assert.equal(verifyBundle(short).hashOk, false);
      const nonhex = JSON.parse(JSON.stringify(b)); nonhex.integrity.hash = "zz".repeat(32);
      assert.equal(verifyBundle(nonhex).hashOk, false);
    } finally { clean(); }
  });
});
