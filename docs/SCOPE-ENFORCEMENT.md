# DA-009 — Scope enforcement for active capability (S0)

Evidence marker: [C] Confirmed from source. Severity: S0 (an active capability
that runs against an operator-supplied target without a recorded authorization
is a privilege/abuse gate; it blocks release until closed).

## The gap (reproduced)

Before this change, the desktop app's active capabilities — TCP port scan
(`scan:ports`), content/directory fuzz (`fuzz:dirs`), subdomain enumeration
(`subdomains:find`), direct TLS connect (`tls:cert`), and arbitrary HTTP to an
operator-supplied target (`http:request`) — ran the moment the IPC handler was
invoked. Nothing recorded who authorized the action, against which target, for
what window, or attested by whom. There was no execution-layer gate; the only
restraint was that the operator had to type a target into a field.

Reproduced by reading `main.js`: each handler above went straight into the
network action with no authorization check.

## What was built

A three-layer design. The gate is enforced in the **main process, inside the
action handler** — not in the renderer. The renderer prompt is a convenience to
collect the authorization; it is not the control.

1. `lib/scope/authz.js` — pure decision core (no Electron, no I/O).
   - `classifyActivity(kind)` maps a kind to an activity **class**
     (`active` / `passive` / `review`). Unknown kinds fail **closed** as
     `active`.
   - `normalizeTarget(hostOrUrl)` canonicalizes to a lowercase host (scheme,
     path, query, and port stripped; `[ipv6]` brackets removed; a bare IPv6
     literal is preserved and not mistaken for `host:port`).
   - `targetCovered(record, target)` — exact host, or a `*.domain` wildcard that
     covers subdomains **but not the apex**. No implicit broadening: an apex
     entry never covers its subdomains.
   - `validateRecord(input)` requires ≥1 target identifier, ≥1 valid activity
     class, a valid `from`/`to` window with `to > from`, and a named attesting
     party. Anything short is rejected.
   - `authorize(action, records, {now, policy})` is the S0 decision. It reads
     **only** the structured `records` store and the action's `kind` + `target`.
     An `active` action **always** requires a covering record (a passed-in
     `requireRecordFor.active:false` is ignored — fail-closed). Default-deny when
     no record matches.

2. `lib/scope/enforce.js` — the `ScopeEnforcer` glue.
   - Records persist to `<userData>/.nexus/scope.json`.
   - `addAuthorization(input)` validates then stores; rejected input is logged
     and **not** stored.
   - `enforce(kind, target)` is the execution-layer gate the handlers call. It
     logs every decision (`permitted` / `refused`) into the existing
     hash-chained, tamper-evident audit trail (`<userData>/.nexus/audit.jsonl`
     via `lib/policy` `auditLog`/`auditVerify`).
   - `preview(kind, target)` is a **non-logging** check used only for UI hinting.
   - Records are mutated **only** through `addAuthorization()` / `revoke()`. The
     `enforce()` path never writes a record, so no tool result or model output
     can author its own authorization.

3. `main.js` — IPC surface + gating.
   - Handlers `scope:authorize` / `scope:list` / `scope:revoke` / `scope:check`.
   - Five active handlers now call `scope().enforce(...)` before the network
     action and return `{ ok:false, blocked:true, error }` (scan/fuzz also emit
     their `*:done` error event) when refused:
     `scan:ports`, `fuzz:dirs`, `subdomains:find`, `tls:cert`, `http:request`.

4. `preload.js` / `renderer/app.js` — the bridge exposes `scopeAuthorize` /
   `scopeList` / `scopeRevoke` / `scopeCheck`. `ensureScope(kind, target)` shows
   an in-app overlay (reusing the palette backdrop — **no native dialog, no
   emoji**) to collect attesting party + time window + optional note, then
   records the authorization. It is wired into the scanner and fuzzer `run()`
   functions. The executor enforces regardless of this UI.

## Why scope cannot be widened without a new attested record

- `authorize()` consults **only** `records` plus the action's `kind`/`target`.
  It ignores every other field on the action object — there is no `override`,
  `instruction`, `authorizedBy`, or `because` that can grant access.
- Records are created only through `addAuthorization()` with attested fields.
  Nothing in the scan/fuzz/subdomain/tls/http executor can add a record.
- Each action is evaluated independently; a prior permitted action never
  broadens what a later one may do (no creep).
- Activity classes are separated: an `active` grant does not satisfy a `passive`
  action and vice-versa (no cross-grant).

## Red-team escape suite (in `test/scope/authz.test.mjs`)

Each of the following is proven **refused**:
- a direct authorization field on the action object (e.g. `override`,
  `authorizedBy`) — ignored;
- authorization text injected via content read from a target/file/tool result —
  ignored;
- incremental creep (authorize host A, then act on host B) — refused;
- tool chaining (a passive action's result used to justify an active one) —
  refused;
- a self-authored record (no attesting party / invalid window) — rejected by
  `validateRecord`, never stored.

`test/scope/enforce.test.mjs` additionally proves: default-deny before any
authorization (and that the refusal is logged); permit after an attested record
(with both events in the hash-chained trail, which verifies); persistence across
enforcer instances; revoke → subsequent refuse; a rejected record is not
persisted; and that editing an audit entry fails `auditVerify`.

## Verification (actual output)

Syntax:

```
$ node --check main.js && node --check preload.js && node --check renderer/app.js \
    && node --check lib/scope/authz.js && node --check lib/scope/enforce.js && echo OK
OK
```

Full suite (zero-dependency harness, `node test/run.mjs`):

```
172 passed, 0 failed  (172 tests, 181ms)
```

(Count rises from the pre-DA-009 baseline by the `test/scope/authz.test.mjs`
and `test/scope/enforce.test.mjs` cases, including the red-team escape suite.)

## Residual risk

- The renderer confirmation UI for `subdomains:find`, `tls:cert`, and
  `http:request` is **not yet** wired — those handlers are fully gated in the
  main process (refusal is returned), but the UI surfaces the raw refusal reason
  rather than offering the in-app authorize overlay. Scanner and fuzzer have the
  overlay. S3 UX gap; the S0 execution-layer gate is in place for all five.
- The attesting party is currently free text supplied by the operator. Binding
  it to a verified identity (Firebase custom claim / signed-in operator) is
  deferred to DA-003 (identity + sync). Until then the audit trail records *what
  was attested*, not *that the attester is who they claim*. S2.
- `govCwd()` is `app.getPath("userData")`, which is per-OS-user. A second local
  OS user has a separate store; this is not a defense against an attacker with
  write access to the same user's `userData` (addressed for credentials in
  DA-008, not here).
- The gate covers the five enumerated active handlers. Any **new** active
  capability must call `scope().enforce(...)`; there is no automatic interception
  of future handlers. Tracked as a convention, not yet a lint.
