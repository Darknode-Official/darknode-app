# Darknode Desktop — Expansion Plan

Goal: grow the desktop app with **genuinely useful, tested, non-filler** code so
it eventually exceeds the web platform in real capability (and line count).
Baseline (2026-09-23): app ≈ 10.5K genuine source lines; web ≈ 385K. This is a
multi-phase program — no filler is ever added to hit a number.

## Principles
- Every addition must do real work the user can exercise, and be verifiable
  (unit tests for pure logic; manual/native checks for IPC).
- Prefer capabilities the **web cannot have**: real command execution, real
  filesystem/forensics, real network probes, real VMs. That's the app's moat.
- Keep the three products (app, `darknode-cli`, web Utilities) in sync — shared
  pure logic is verified against the CLI modules so they don't drift.
- No emojis in UI; no `prompt/alert/confirm` (custom modals); privileged work
  always crosses the validated IPC boundary in `main.js`.

## Progress
- Phase 1 — DONE (commit "Phase 1: tested pure security toolkit"): 5 modules +
  barrel + harness, 67 tests passing.
- Phase 2 — DONE (commit "Phase 2: native File Forensics section"): forensics
  IPC + renderer section over real file bytes.
- Next: Phase 3 (workspaces) — or extend Phase 2 (PCAP summary, cert inspector).

## Phase 1 — Tested core toolkit (`lib/toolkit/`) + harness  ✓ DONE
Factor the inline renderer helpers into pure, tested CommonJS modules and expand
them into a real library. Add a zero-dependency Node test harness + `npm test`.
- `encoding.js` — base64/32/58, hex, url, html entities, rot-n, morse, ascii85.
- `hashing.js` — crc32, djb2/fnv, luhn, simple checksums (Node `crypto` for real
  md5/sha families).
- `crypto.js` — XOR, Vigenère, Caesar, one-time-pad, classic ciphers.
- `net.js` — IP classification/CIDR math, MAC parsing, port/protocol lookup,
  URL/JWT/UA dissection.
- `forensics.js` — string extraction, hexdump, entropy, magic-byte file typing.
Each module: pure functions, `module.exports`, mirrored by a `*.test.mjs`.

## Phase 2 — Native-backed tool modules (IPC + renderer sections)
Real file forensics (hash/entropy/strings/hexdump of chosen files), packet/PCAP
summary, local cert/keystore inspection, process/port enumeration, hosts-file &
DNS-cache tools — each an IPC handler in `main.js` + a renderer section.

## Phase 3 — Workspace & case management
Engagement workspaces persisted to disk: scope, hosts, findings, evidence,
timeline, report export (Markdown/HTML/PDF). Ties recon/scan/loot together.

## Phase 4 — Playbook & automation engine
A real chained-step runner (recon → scan → enrich → report) with typed steps,
guardrails (scope enforcement), and resumable runs.

## Phase 5 — Knowledge & reference depth
Offline CVE/MITRE/technique reference bundles, payload/wordlist libraries with
real generators, and a searchable local index.

Progress is tracked by `npm test` (green) and honest `wc -l` of genuine source.
