// Secret scanner tests (DA-008) — catches planted secrets, honours the allowlist.
import { test, group, assert } from "../harness.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S from "../../lib/secret/scan.js";

const { scanText, scanTree } = S;

group("scan: detection", () => {
  test("catches a planted GitHub token", () => {
    const f = scanText("const t = 'ghp_ABCdefGHIjkl0123456789MNOpqrSTUvwx12';");
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, "github-token");
    assert.ok(f[0].masked.indexOf("ABCdefGHIjkl") === -1, "finding must not expose the full secret");
  });

  test("catches an AWS access key id and reports a line number", () => {
    const f = scanText("line1\nline2 AKIAIOSFODNN7EXAMPLE\nline3");
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 2);
  });

  test("clean text yields no findings", () => {
    assert.equal(scanText("just some ordinary source code, nothing secret here").length, 0);
  });

  test("allowlist suppresses a known value", () => {
    const text = "const VT='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';\nconst g='ghp_ABCdefGHIjkl0123456789MNOpqrSTUvwx12';";
    const withAllow = scanText(text, { allow: [/ghp_ABCdefGHIjkl/] });
    assert.ok(withAllow.every((x) => x.rule !== "github-token"), "allowlisted token must be suppressed");
  });
});

group("scan: tree walk", () => {
  test("finds a secret in a file and skips ignored dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "dn-scan-"));
    try {
      writeFileSync(join(root, "ok.js"), "export const x = 1; // fine\n");
      writeFileSync(join(root, "leak.js"), "const k = 'sk-ant-api03-ABCdef0123456789ABCdef0123';\n");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "dep.js"), "const k = 'ghp_ABCdefGHIjkl0123456789MNOpqrSTUvwx12';\n");
      const res = scanTree(root);
      assert.ok(res.findings.some((f) => f.file === "leak.js"), "must flag leak.js");
      assert.ok(!res.findings.some((f) => f.file.indexOf("node_modules") !== -1), "must skip node_modules");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("reads security/secret-allowlist.json from the tree root", () => {
    const root = mkdtempSync(join(tmpdir(), "dn-scan-"));
    try {
      mkdirSync(join(root, "security"));
      writeFileSync(join(root, "security", "secret-allowlist.json"), JSON.stringify({ patterns: ["AKIAIOSFODNN7EXAMPLE"] }));
      writeFileSync(join(root, "a.js"), "const id = 'AKIAIOSFODNN7EXAMPLE';\n");
      const res = scanTree(root);
      assert.ok(!res.findings.some((f) => f.rule === "aws-access-key-id"), "allowlisted AWS id suppressed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
