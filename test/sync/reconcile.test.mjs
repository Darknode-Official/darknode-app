// Tests for lib/sync/reconcile.js (DA-003) — the deterministic conflict path.
import { test, group, assert } from "../harness.mjs";
import R from "../../lib/sync/reconcile.js";

const { reconcile, compact } = R;

const item = (id, value, updatedAt, updatedBy, deleted) => ({ id, value, updatedAt, updatedBy, deleted: !!deleted });
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

group("sync: reconcile — merge", () => {
  test("unions non-overlapping items", () => {
    const a = [item("x", "ax", 10, "d1")];
    const b = [item("y", "by", 10, "d2")];
    const { merged } = reconcile(a, b);
    const m = byId(merged);
    assert.equal(merged.length, 2);
    assert.equal(m.x.value, "ax");
    assert.equal(m.y.value, "by");
  });

  test("newer updatedAt wins (both directions)", () => {
    const older = item("k", "old", 100, "d1");
    const newer = item("k", "new", 200, "d2");
    assert.equal(byId(reconcile([older], [newer]).merged).k.value, "new");
    assert.equal(byId(reconcile([newer], [older]).merged).k.value, "new");
  });

  test("delete tombstone newer than an edit removes the item", () => {
    const edit = item("k", "v", 100, "d1");
    const del = item("k", null, 200, "d2", true);
    const m = byId(reconcile([edit], [del]).merged);
    assert.ok(m.k.deleted, "tombstone should win");
  });

  test("edit newer than a delete resurrects the item", () => {
    const del = item("k", null, 100, "d1", true);
    const edit = item("k", "back", 200, "d2");
    const m = byId(reconcile([del], [edit]).merged);
    assert.notOk(m.k.deleted, "edit should win and un-delete");
    assert.equal(m.k.value, "back");
  });
});

group("sync: reconcile — determinism (the conflict path)", () => {
  test("is commutative: reconcile(a,b) == reconcile(b,a)", () => {
    const a = [item("k", "A", 100, "dA"), item("p", "P1", 50, "dA")];
    const b = [item("k", "B", 100, "dB"), item("p", "P2", 80, "dB")];
    const ab = reconcile(a, b).merged;
    const ba = reconcile(b, a).merged;
    assert.deepEqual(ab, ba, "merge must not depend on argument order");
  });

  test("equal-timestamp tie breaks on updatedBy, stably on both sides", () => {
    // Same clock, same id, different author -> higher author id wins, both ways.
    const a = [item("k", "fromA", 100, "device-A")];
    const b = [item("k", "fromB", 100, "device-B")];
    assert.equal(byId(reconcile(a, b).merged).k.value, "fromB");
    assert.equal(byId(reconcile(b, a).merged).k.value, "fromB");
  });

  test("fully-equal clock+author tie breaks on content, deterministically", () => {
    const a = [item("k", "alpha", 100, "d")];
    const b = [item("k", "beta", 100, "d")];
    const r1 = byId(reconcile(a, b).merged).k.value;
    const r2 = byId(reconcile(b, a).merged).k.value;
    assert.equal(r1, r2, "content tie-break must converge");
  });

  test("is idempotent: reconcile(m, m) == m", () => {
    const m = reconcile([item("k", "v", 100, "d1")], [item("j", "w", 90, "d2")]).merged;
    const again = reconcile(m, m).merged;
    assert.deepEqual(again, m);
  });

  test("reports the conflict count", () => {
    const a = [item("k", "A", 100, "dA"), item("only", "x", 1, "dA")];
    const b = [item("k", "B", 150, "dB")];
    const { report } = reconcile(a, b);
    assert.equal(report.conflicts, 1, "one shared-id conflict resolved");
  });
});

group("sync: reconcile — compaction", () => {
  test("drops tombstones older than the horizon, keeps live + recent", () => {
    const now = 1_000_000_000_000;
    const items = [
      item("live", "v", now, "d1"),
      item("oldDel", null, now - 40 * 24 * 3600 * 1000, "d1", true),
      item("newDel", null, now - 1 * 24 * 3600 * 1000, "d1", true),
    ];
    const kept = compact(items, 30 * 24 * 3600 * 1000, now).map((i) => i.id);
    assert.ok(kept.includes("live"));
    assert.ok(kept.includes("newDel"));
    assert.ok(!kept.includes("oldDel"), "stale tombstone should be compacted away");
  });
});
