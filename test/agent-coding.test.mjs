// Unit tests for renderer/agent-coding.js — the app home agent's on-machine coding brain.
// This bundle is vendored verbatim (pure, no-fs logic) from the darknode-cli Nexus engine, so it
// stays testable in plain Node even though it ships as a browser <script>. The file self-registers
// on `window` in the renderer and on `module.exports` under CommonJS; we load it via createRequire.
import { test, group, assert } from "./harness.mjs";
import { createRequire } from "node:module";
const NC = createRequire(import.meta.url)("../renderer/agent-coding.js");

group("agent-coding: repo map + symbols", () => {
  test("ranks source files and outlines symbols", () => {
    const files = [
      { path: "src/index.js", content: "export function main(){}\nclass Foo{ bar(){} }" },
      { path: "test/x.test.js", content: "it('a',()=>{})" },
      { path: "node_modules/pkg/i.js", content: "function skip(){}" }, // not filtered here (caller filters), but still mapped
    ];
    const map = NC.buildRepoMap(files);
    assert.ok(map.fileCount >= 2, "at least the two real files mapped");
    assert.ok(map.symbolCount >= 2, "found main + Foo");
    const text = NC.renderRepoMap(map, { maxFiles: 10 });
    assert.ok(/main/.test(text) && /Foo/.test(text), "outline names the symbols");
  });
  test("isSourceFile discriminates code from noise", () => {
    assert.ok(NC.isSourceFile("a/b/c.py"));
    assert.notOk(NC.isSourceFile("image.png"));
    assert.notOk(NC.isSourceFile("package-lock.json"));
  });
  test("find_symbol ranks exact definition first", () => {
    const map = NC.buildRepoMap([{ path: "src/a.js", content: "function mainLoop(){}\nfunction main(){}" }]);
    const hits = NC.findSymbol(map, "main");
    assert.equal(hits[0].name, "main", "exact match wins over substring 'mainLoop'");
    assert.equal(hits[0].kind, "fn");
  });
});

group("agent-coding: reliable edits", () => {
  test("multi-edit is atomic (one bad find touches nothing)", () => {
    const r = NC.applyEdits("a\nb\nc\n", [{ find: "a", replace: "A" }, { find: "ZZZ", replace: "x" }]);
    assert.notOk(r.ok, "fails because ZZZ is absent");
  });
  test("multi-edit applies all when every find resolves", () => {
    const r = NC.applyEdits("a\nb\nc\n", [{ find: "a", replace: "A" }, { find: "c", replace: "C" }]);
    assert.ok(r.ok); assert.equal(r.content, "A\nb\nC\n");
  });
  test("flexible fallback re-indents to the matched block", () => {
    // find omits indentation; the file has 4-space indent — replacement should inherit it.
    const r = NC.applyEditsFlexible("    return  x\n", [{ find: "return x", replace: "return y\nlog(y)" }]);
    assert.ok(r.ok); assert.equal(r.content, "    return y\n    log(y)\n");
  });
  test("ambiguous flexible match refuses rather than guessing", () => {
    const r = NC.applyEditsFlexible("foo()\nfoo()\n", [{ find: "foo( )", replace: "bar()" }]);
    assert.notOk(r.ok, "two matches => error, never a silent edit");
  });
});

group("agent-coding: patch application", () => {
  test("applies a unified diff anchored on context", () => {
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n keep1\n-old\n+new\n keep2\n";
    const files = NC.parsePatch(patch);
    assert.equal(files.length, 1); assert.equal(files[0].file, "f.txt");
    const r = NC.applyHunks("keep1\nold\nkeep2\n", files[0].hunks);
    assert.ok(r.ok); assert.equal(r.content, "keep1\nnew\nkeep2\n");
  });
  test("patch anchors even when line numbers drift", () => {
    // Extra leading lines shift real positions away from the @@ header — context still finds it.
    const patch = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n anchor\n-x\n+y\n";
    const r = NC.applyHunks("pad\npad\nanchor\nx\n", NC.parsePatch(patch)[0].hunks);
    assert.ok(r.ok); assert.equal(r.content, "pad\npad\nanchor\ny\n");
  });
});

group("agent-coding: verify detection", () => {
  test("prefers the project's own test command", () => {
    const cmds = NC.detectProjectCommands(["package.json"], { "package.json": JSON.stringify({ scripts: { test: "jest", build: "tsc" } }) });
    assert.deepEqual(NC.pickVerify(cmds), { kind: "test", cmd: "npm test" });
  });
  test("detects pytest for a python project with no package.json", () => {
    const cmds = NC.detectProjectCommands(["pyproject.toml", "tests"], {});
    assert.equal(cmds.test, "pytest -q");
  });
  test("returns null when nothing is runnable", () => {
    assert.equal(NC.pickVerify(NC.detectProjectCommands(["README.md"], {})), null);
  });
});
