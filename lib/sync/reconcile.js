// Darknode sync — deterministic workspace reconciler (provider-agnostic).
//
// DA-003 requires that "sync reconciles deterministically on reconnect with a
// tested conflict path." This module is that reconciler, kept independent of any
// identity provider or transport so it can be unit-tested offline and reused
// whether sync lands on Firestore, a local file, or anything else.
//
// Model — a workspace is a flat map of items keyed by id. Each item:
//   { id, value, updatedAt, updatedBy, deleted? }
//     updatedAt  epoch ms (number) — the Lamport-ish clock
//     updatedBy  stable principal/device id (string) — the tie-breaker
//     deleted    true for a tombstone (a delete is an update, not a removal)
//
// reconcile(a, b) is a last-writer-wins register merge that is COMMUTATIVE and
// IDEMPOTENT: two devices that each merge the other's state converge to the same
// result regardless of which side runs the merge or in what order. Winner per id:
//   1. greater updatedAt
//   2. tie -> greater updatedBy (lexicographic)
//   3. still tie -> greater JSON(value)+deleted (content), so even identical
//      clocks from different content resolve the same way on both sides.
//
// Verified by test/sync/reconcile.test.mjs.

function contentKey(item) {
  try { return JSON.stringify([item.value === undefined ? null : item.value, !!item.deleted]); }
  catch (_) { return String(item.value) + "|" + !!item.deleted; }
}

// Total order over two items for the SAME id. Returns the winner (deterministic).
function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Number(a.updatedAt) || 0, tb = Number(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb ? a : b;
  const ua = String(a.updatedBy || ""), ub = String(b.updatedBy || "");
  if (ua !== ub) return ua > ub ? a : b;
  const ca = contentKey(a), cb = contentKey(b);
  if (ca !== cb) return ca > cb ? a : b;
  return a; // fully identical
}

function indexById(items) {
  const m = new Map();
  for (const it of items || []) if (it && it.id != null) m.set(String(it.id), it);
  return m;
}

// reconcile(a, b) -> { merged, report }
//   merged: item[] sorted by id (stable output, tombstones included)
//   report: { fromA, fromB, conflicts } counts for observability/testing
function reconcile(a, b) {
  const A = indexById(Array.isArray(a) ? a : (a && a.items) || []);
  const B = indexById(Array.isArray(b) ? b : (b && b.items) || []);
  const ids = new Set([...A.keys(), ...B.keys()]);
  const merged = [];
  let fromA = 0, fromB = 0, conflicts = 0;
  for (const id of ids) {
    const ia = A.get(id), ib = B.get(id);
    if (ia && ib) {
      // Same id present on both sides and they differ -> a conflict was resolved.
      if (contentKey(ia) !== contentKey(ib) || (Number(ia.updatedAt) || 0) !== (Number(ib.updatedAt) || 0)) conflicts++;
    }
    const w = pick(ia, ib);
    if (w === ia && ib && w !== ib) fromA++;
    else if (w === ib && ia && w !== ia) fromB++;
    merged.push(w);
  }
  merged.sort((x, y) => (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  return { merged, report: { fromA, fromB, conflicts } };
}

// Drop tombstones older than `horizon` ms — safe compaction once every device has
// certainly seen the delete. Keeps the merge from growing without bound.
function compact(items, horizon, now) {
  const cut = (now == null ? Date.now() : now) - (horizon == null ? 30 * 24 * 3600 * 1000 : horizon);
  return (items || []).filter((it) => !(it && it.deleted && (Number(it.updatedAt) || 0) < cut));
}

module.exports = { reconcile, pick, compact, contentKey };
