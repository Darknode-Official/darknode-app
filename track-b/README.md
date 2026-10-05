# Darknode OS — Track B foundation

DO-001 is signed (**Track B**): the shipping **Darknode OS** is a Linux
distribution with a custom compositor/shell/theme and an agentic security stack.
The from-scratch x86 kernel is a separate research project ("Darknode Obsidian")
and is NOT this product.

This subtree is the bounded, verifiable foundation. It is intentionally
self-contained (liftable into a dedicated repo via `git subtree split`).

## Layout
- `distro/` — DO-010 declarative, reproducible image definition + package
  manifest (skeleton).
- `agent-control/` — DO-013 agent-as-system-service control plane and the
  runnable scope-escape release-gate test suite (the differentiator).
- `hardening/` — DO-014 hardening baseline and a runnable conformance checker
  with real passing checks.
- `docs/TRACK-B-STATUS.md` — what was verified this run, what is NOT YET
  EXECUTED (with reasons), and the recommended home for the shipping distro.

## Verify (both gates pass today)
```sh
node --test track-b/agent-control/scope-escape.test.mjs   # 11/11 pass
node track-b/hardening/conformance-check.mjs              # 5 pass, 0 fail, exit 0
```

## Scope note
Nothing here claims to be a built OS. No image has been built or booted; no
compositor, browser, native app, or hardware test has been run. Those require a
build host / GPU / real hardware / CI and are listed as NOT YET EXECUTED in
`docs/TRACK-B-STATUS.md`.
