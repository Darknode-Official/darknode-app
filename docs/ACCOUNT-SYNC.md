# Account / Sync / Identity Parity — DA-003

**Status:** PARTIAL. The [V] offline claim is reproduced and holds; the deterministic
conflict reconciler (the hardest, most-defect-prone piece the brief names) is built
and tested; identity-provider + transport wiring is DEFERRED (decision-blocked).
**Date:** 2026-10-04

## [V] reproduction — offline-first for local capability

The brief marks DA-003 [V]: reproduce before remediating. Reproduced from source
in `darknode-app`:

- No sign-in gate, no allow-list, and no Firebase/Firestore exist in the app.
  `grep -rniE 'sign.?in|allow.?list|firebase|firestore|onAuthState|ensureUser'`
  over `renderer/app.js`, `main.js`, `preload.js` returns only: optional Gmail
  OAuth (`gmail:oauth`), optional GitHub token use, and unrelated substrings
  (e.g. `COMMON_PATHS` containing `"login"`). There is no boot-time auth check.
- Boot path: `renderer/app.js` boot restores `localStorage["s_last_sec"]` and
  calls `go(sec)` directly; no gate precedes section rendering.
- Every local capability (offline toolbox, encode/decode/hash, file forensics,
  native CLI tools, notes, reference libraries) runs with no network and no
  account.

**Conclusion:** the DA-003 acceptance "a signed-out, network-isolated launch
reaches full local capability" is **already satisfied by construction** — the
desktop has no gate to fail. This also means the web's defects that DA-003
forbids importing (hard-coded `OWNER_EMAIL` literal; client-side gate evaluation
as a security control) are **absent** here, and must not be introduced when sync
is added.

The remaining gap is the inverse: the app has **no** sync/identity/entitlements
at all (DA-001 matrix row 22). Closing it means *adding* sync without adding a
gate that blocks local use.

## Built this item — deterministic reconciler

`lib/sync/reconcile.js` (provider-agnostic, no transport, no identity coupling):

- Workspace = flat map of items `{ id, value, updatedAt, updatedBy, deleted? }`.
- `reconcile(a, b)` is a last-writer-wins register merge that is **commutative**
  and **idempotent**: two devices each merging the other converge to the same
  result irrespective of order. Winner per id: greater `updatedAt`; tie →
  greater `updatedBy`; still tie → greater content. Deletes are tombstones, so a
  delete and a concurrent edit resolve deterministically either way.
- `compact(items, horizon, now)` drops tombstones older than a horizon so the
  merged set does not grow without bound.

Tested in `test/sync/reconcile.test.mjs` (10 tests): union, newer-wins (both
directions), delete-over-edit, edit-over-delete (resurrect), **commutativity**,
equal-clock tie-break stability, content tie-break convergence, idempotence,
conflict-count report, and compaction. This is the "tested conflict path" the
acceptance names.

### Verification

```
$ npm test
  ok   sync: reconcile — determinism (the conflict path) › is commutative: reconcile(a,b) == reconcile(b,a)
  ok   sync: reconcile — determinism (the conflict path) › is idempotent: reconcile(m, m) == m
  ... (10 sync tests)
111 passed, 0 failed  (111 tests, 180ms)
```

## Deferred (decision-blocked) — identity provider + transport

NOT built this item, because it depends on an owner decision that cannot be
round-tripped mid-run (see Clarifications in the run report):

1. **Identity provider.** Reuse the web's Firebase Auth (shared accounts across
   web + desktop) or a desktop-local identity? This changes the entire client
   dependency surface and the entitlement model.
2. **Transport / store.** Sync to the web's Firestore `users/{uid}` (shared
   workspace with the console) or to a neutral store? Reusing Firestore requires
   embedding Firebase web config in the Electron renderer and matching the
   Security Rules.
3. **Entitlements.** The brief requires entitlements evaluated server-side
   (never a client gate). That needs the chosen backend's claim/record model.

When the provider is chosen, the sync client wires to `reconcile()` unchanged:
pull remote → `reconcile(local, remote)` → push `merged` → persist `merged`
locally. Entitlements gate **sync and hosted features only**, never local tools
(preserving the offline property proven above).

## Residual risk

- The reconciler is proven in isolation; end-to-end sync (auth → pull → merge →
  push → persist) is unproven because the provider is undecided.
- `updatedAt` is wall-clock epoch ms; large clock skew between devices could let
  a stale write win. A follow-up could layer a per-item version counter
  (Lamport) on top of the same `pick()` ordering without changing its interface.
