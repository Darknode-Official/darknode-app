# DO-013 — Agentic security as a supervised system service

This is the differentiator of Darknode OS (Track B): the Nexus agent is a
first-class system service with kernel-side authorization, not an app the user
launches. This directory contains the **control design** and a **runnable
scope-escape test suite** that is the release gate. It is implemented in Node
(zero extra dependencies) so the controls are testable without a GUI, GPU, or a
built image; the shipping OS maps the same contract onto kernel capabilities and
the system audit journal.

## Run the release gate

```sh
node --test track-b/agent-control/scope-escape.test.mjs
```

Current status: **11/11 passing** (verified this run). Every scope-escape
attempt the brief names is refused and logged.

## Design

### Service model
- The agent runs under a supervisor (`darknode-agent.service`) with a defined
  lifecycle and resource limits, exposing a stable local API. It is not launched
  per-use by the user.
- Local inference by default; hosted engines are opt-in and surfaced in the UI,
  and the OS always states what is leaving the machine (not modeled in this
  skeleton; a design requirement recorded here).

### The one chokepoint (`policy.mjs`)
The agent is **untrusted**. It can only act by:
1. asking the `PolicyEngine` to `authorize(action)`, and
2. handing the returned signed **grant** to the `Executor`.

The `Executor` runs nothing without a valid, action-bound, unexpired grant
issued by the engine. There is no bypass path — a confused or compromised agent
is stopped here, below the UI, not by its own good behavior.

### Scope comes only from authorization records (`authorization.mjs`)
A target is not actionable until an `AuthorizationRecord` exists, carrying:
target identifiers, permitted activity classes, a time window, and the attesting
party. Records are installed through a **privileged out-of-band channel**
(`addAuthorization`), which accepts only validated `AuthorizationRecord`
instances. An action request can never install or widen scope.

Enforced invariants (each covered by a test):
- **No scope from data.** Actions whose origin is `CONTENT` or `TOOL_RESULT`
  (text read from a target, a tool's output) can only act within pre-existing
  records, and any authorization they try to carry is refused as data.
- **Three activity classes authorized separately:** passive lookup, material
  review, active interaction.
- **No widening** by direct instruction, injected content, incremental creep
  (walking past a CIDR boundary), or tool chaining (acting on a host a tool
  "discovered").
- **Time-bounded:** actions outside `[notBefore, notAfter]` are denied.
- **Destructive actions** require both a permitting record and explicit operator
  confirmation; reversibility where the filesystem permits is a design
  requirement (snapshot-before-destroy on the btrfs subvolumes).

### Append-only audit (`audit-log.mjs`)
Every authorization decision, execution, and block is appended to a hash-chained
log. The only public mutation is `append()`; returned entries are frozen; there
is no delete/rewrite API; `verify()` detects any out-of-band tampering. In the
shipping OS this is backed by the append-only audit journal on its own btrfs
subvolume.

## What this skeleton does NOT yet do (NOT YET EXECUTED)
- Bind to real kernel capabilities / seccomp / LSM hooks (needs a running
  image). The JS `Executor` models the chokepoint; it is not yet the kernel.
- Confine the agent process with the sandbox profiles from DO-014 at runtime.
- Persist the audit journal to `/var/log/darknode/audit` across reboot.
These require a built image and are tracked in `../docs/TRACK-B-STATUS.md`.
