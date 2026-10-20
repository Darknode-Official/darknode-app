// Unit tests for lib/usage.js — the per-project AI usage ledger + reporting.
// The module header claims summarize()/renderReport() are "pure so they are
// unit-tested"; this is that test. appendUsage/loadUsage are exercised against
// a real temp directory, then removed.
import { test, group, assert } from "../harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import U from "../../lib/usage.js";

const { appendUsage, loadUsage, summarize, renderReport, MONEY, TOK } = U;

function tmpProject() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "dn-usage-"));
  return { dir, clean: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

const recs = [
  { ts: "2026-06-01T09:00:00Z", engine: "claude", model: "opus", operator: "alice", team: "red", inTok: 1000, outTok: 500, cost: 0.03, files: 2, commands: 1, seconds: 12 },
  { ts: "2026-06-01T10:00:00Z", engine: "claude", model: "opus", operator: "bob", team: "red", inTok: 2000, outTok: 1000, cost: 0.06, files: 0, commands: 3, seconds: 20, interrupted: true },
  { ts: "2026-06-02T09:00:00Z", engine: "ollama", model: "llama3", operator: "alice", team: "blue", inTok: 5000, outTok: 2000, cost: 0, files: 1, commands: 0, seconds: 40 },
];

group("usage: summarize", () => {
  const s = summarize(recs);
  test("aggregate totals", () => {
    assert.equal(s.turns, 3);
    assert.equal(s.inTok, 8000);
    assert.equal(s.outTok, 3500);
    assert.close(s.cost, 0.09, 1e-9);
    assert.equal(s.files, 3);
    assert.equal(s.commands, 4);
    assert.equal(s.interrupted, 1);
  });
  test("breakdown by engine", () => {
    assert.equal(s.byEngine.claude.turns, 2);
    assert.close(s.byEngine.claude.cost, 0.09, 1e-9);
    assert.equal(s.byEngine.ollama.turns, 1);
  });
  test("breakdown by operator and team (chargeback)", () => {
    assert.equal(s.byOperator.alice.turns, 2);
    assert.equal(s.byOperator.bob.turns, 1);
    assert.equal(s.byTeam.red.turns, 2);
    assert.equal(s.byTeam.blue.turns, 1);
  });
  test("day buckets + first/last ts", () => {
    assert.equal(Object.keys(s.byDay).length, 2);
    assert.equal(s.firstTs, "2026-06-01T09:00:00Z");
    assert.equal(s.lastTs, "2026-06-02T09:00:00Z");
  });
  test("empty input is all-zero, no crash", () => {
    const z = summarize([]);
    assert.equal(z.turns, 0);
    assert.equal(z.firstTs, null);
  });
  test("missing fields default to 0 / unknown", () => {
    const z = summarize([{ ts: "2026-06-01T00:00:00Z" }]);
    assert.equal(z.inTok, 0);
    assert.ok(z.byEngine.unknown);
    assert.ok(z.byOperator.unknown);
  });
  test("a __proto__ model is tallied, not dropped, and does not poison Object.prototype", () => {
    const z = summarize([{ ts: "2026-01-01T00:00:00Z", engine: "claude", model: "__proto__", cost: 5, inTok: 10, outTok: 20 }]);
    assert.equal(z.byModel["__proto__"].turns, 1);
    assert.close(z.byModel["__proto__"].cost, 5, 1e-9);
    assert.equal(({}).turns, undefined); // prototype intact
  });
});

group("usage: formatters", () => {
  test("MONEY fixed 4dp", () => {
    assert.equal(MONEY(0.12345), "$0.1235");
    assert.equal(MONEY(0), "$0.0000");
    assert.equal(MONEY(undefined), "$0.0000");
  });
  test("TOK humanizes", () => {
    assert.equal(TOK(500), "500");
    assert.equal(TOK(1500), "1.5k");
    assert.equal(TOK(2_000_000), "2.00M");
  });
});

group("usage: renderReport", () => {
  const out = renderReport(summarize(recs), { project: "demo" });
  test("includes header, period, cost, and breakdowns", () => {
    assert.ok(out.includes("Nexus usage report — demo"));
    assert.ok(out.includes("2026-06-01 → 2026-06-02"));
    assert.ok(out.includes("$0.0900"));
    assert.ok(out.includes("By engine"));
    assert.ok(out.includes("By team"));
    assert.ok(out.includes("By operator"));
  });
  test("deterministic (same input -> same output)", () => {
    assert.equal(renderReport(summarize(recs), { project: "demo" }), out);
  });
});

group("usage: append + load round-trip", () => {
  test("appendUsage writes JSONL that loadUsage reads back", () => {
    const { dir, clean } = tmpProject();
    try {
      assert.equal(appendUsage(dir, recs[0]), true);
      assert.equal(appendUsage(dir, recs[1]), true);
      const got = loadUsage(dir);
      assert.equal(got.length, 2);
      assert.equal(got[0].operator, "alice");
      assert.ok(fs.existsSync(join(dir, ".nexus", "usage.jsonl")));
    } finally { clean(); }
  });
  test("loadUsage skips malformed lines and honors `since`", () => {
    const { dir, clean } = tmpProject();
    try {
      fs.mkdirSync(join(dir, ".nexus"), { recursive: true });
      fs.writeFileSync(join(dir, ".nexus", "usage.jsonl"),
        JSON.stringify({ ts: "2026-06-01T00:00:00Z", cost: 1 }) + "\n" +
        "{ not json\n" +
        JSON.stringify({ ts: "2026-07-01T00:00:00Z", cost: 2 }) + "\n");
      assert.equal(loadUsage(dir).length, 2);
      assert.equal(loadUsage(dir, { since: "2026-06-15" }).length, 1);
    } finally { clean(); }
  });
  test("loadUsage on a project with no ledger returns []", () => {
    const { dir, clean } = tmpProject();
    try { assert.deepEqual(loadUsage(dir), []); } finally { clean(); }
  });
});

// The import path stability check doubles as a guard that the module layout the
// header documents still resolves.
group("usage: module shape", () => {
  test("exports the documented surface", () => {
    for (const fn of [appendUsage, loadUsage, summarize, renderReport, MONEY, TOK]) assert.equal(typeof fn, "function");
  });
  test("harness cwd is a real path", () => {
    assert.ok(fs.existsSync(dirname(fileURLToPath(import.meta.url))));
  });
});
