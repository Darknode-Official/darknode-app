# Native Execution Advantage — what the desktop does that the web cannot

**Work item:** DA-002
**Status:** PARTIAL — native paths enumerated; recon scan + fuzz extracted into testable modules and backed by native-path tests; remaining paths documented with the reason they are not yet test-backed.
**Date:** 2026-10-04

Each capability below is something a browser can only simulate, link out to, or
cannot do at all, and that the desktop main process executes against the real
OS/network. "Test" names the file that exercises the native path; "NOT YET
TESTED" states why a runnable test is not yet present.

## Test-backed native paths

| Capability | What desktop does that web cannot | IPC handler (main.js) | Core module | Test |
|---|---|---|---|---|
| TCP port scan | Opens real TCP sockets to a host across a port range, grabs a service banner, bounded concurrency + timeout, cancellable. A browser cannot open an arbitrary TCP socket. | `scan:ports` | `lib/recon/portscan.js` `scanPorts()` | `test/recon/portscan.test.mjs` — scans a real loopback listener, asserts open vs closed, banner capture, progress, cancel (4 tests) |
| Content/dir fuzz | Sends real GET requests to base+word and reports non-404 paths, including 3xx + Location. A browser is blocked cross-origin (CORS/opaque). | `fuzz:dirs` | `lib/recon/fuzz.js` `fuzzDirs()`/`headReq()` | `test/recon/fuzz.test.mjs` — fuzzes a real loopback HTTP server, asserts hit vs 404, redirect, unreachable (3 tests) |
| File forensics | Reads a real file on disk (≤64 MB), computes MD5/SHA1/SHA256/CRC32, Shannon-entropy verdict, magic-byte type, hexdump, extracted strings. A browser cannot read arbitrary local files. | `forensics:analyze` | `lib/toolkit` (`md5`/`sha*`/`crc32Hex`/`entropyVerdict`/`detectFileType`/`hexdump`/`extractStrings`) | `test/toolkit/*.test.mjs` (hashing, forensics, encoding, crypto, cvss, net) — the forensics primitives are covered; the file-read wrapper is a thin `fs` call |
| Offline toolbox (73 tools) | Hashing, encoding, ciphers, generators, net math run entirely in-app with no network and no darknode.ai. The web runs equivalents only inside a loaded page. | n/a (renderer) | `renderer/webtools-native.js` | primitives shared with `lib/toolkit` tests; see DA-012 for a dedicated `webtools-native` suite (not yet written) |

## Native paths documented but NOT YET test-backed

Each is implemented in `main.js` and reachable through `preload.js`; a runnable
test is deferred for the stated reason. These are reported as NOT YET EXECUTED,
not as complete.

| Capability | IPC handler | What desktop does that web cannot | Why not yet tested |
|---|---|---|---|
| DNS records | `dns:lookup` | Native resolver: A/AAAA/MX/NS/TXT/CNAME/SOA + reverse PTR. | Needs live DNS; a hermetic test requires a stub resolver (DA-012). |
| WHOIS | `whois:query` | Raw TCP/43 to IANA then follows the referral server. | Needs live network to port 43; sandbox-blocked. |
| TLS certificate | `tls:cert` | Real TLS handshake, reads peer cert chain, SANs, validity. | Needs a live TLS endpoint or a local TLS server fixture (deferred). |
| Subdomain enum | `subdomains:find` | crt.sh CT-log query over the network. | Needs live network/HTTP; deferred to a mocked-fetch harness. |
| CVE search | `cve:search` | Live NVD query. | Needs live network; deferred to a mocked-fetch harness. |
| HTTP request | `http:request` | Arbitrary method/headers/body with no CORS restriction. | Local-server test feasible; deferred (same pattern as fuzz test). |
| QEMU VM runner | `vm:*` | Creates qcow2 disks, boots `qemu-system-x86_64`, controls over QMP, builds Darknode OS. Web cannot run a VM. | Needs QEMU installed + hardware virt; cannot run in this environment. |
| git / GitHub | `git:*`, `github:*` | clone/pull/push/branch/checkout/log/diff/status + GitHub API (issues/PR/gist/comment). | Needs a git binary + a scratch repo fixture; deferred to DA-012. |
| pty terminals | `pty:*` | Real pseudo-terminals via node-pty. Web has no shell. | Needs node-pty native build + a pty-capable CI runner; deferred. |
| MCP client | `mcp:*` | Connects to MCP servers, lists/calls tools, reads resources. | Needs a stub MCP server fixture; deferred. |

## Diff reference

- `lib/recon/portscan.js` (new) — extracted TCP connect-scan core, Electron-decoupled via callbacks.
- `lib/recon/fuzz.js` (new) — extracted content-fuzz core (`headReq`, `fuzzDirs`), Electron-decoupled.
- `main.js` — `scan:ports` and `fuzz:dirs` handlers now delegate to the extracted cores; inline `headReq` removed. Behavior preserved (same renderer events: `scan:hit`/`scan:progress`/`scan:done`, `fuzz:hit`/`fuzz:progress`/`fuzz:done`; same `scans`/`fuzzes` cancel maps).
- `test/recon/portscan.test.mjs`, `test/recon/fuzz.test.mjs` (new) — native-path tests on loopback servers.

## Verification

```
$ npm test
Discovered 9 test file(s).
  ok   recon: fuzz (native HTTP content discovery) › finds a non-404 path and skips 404s
  ok   recon: fuzz (native HTTP content discovery) › reports a redirect (3xx) with its Location
  ok   recon: fuzz (native HTTP content discovery) › headReq returns null for an unreachable base
  ok   recon: portscan (native TCP connect) › reports an open loopback port and skips a closed one
  ok   recon: portscan (native TCP connect) › grabs a service banner when the server sends one
  ok   recon: portscan (native TCP connect) › onProgress fires once per probed port
  ok   recon: portscan (native TCP connect) › honors a cancel signal
101 passed, 0 failed  (101 tests, 178ms)

$ node --check main.js   # passes (handlers still parse after extraction)
```

## Residual risk

- The extraction preserves observable behavior but was verified by `node --check` + the new unit tests, NOT by launching Electron (no GUI/display in this environment). A smoke-run of the app on real hardware remains owner-side.
- The NOT-YET-TESTED paths depend on live network, QEMU, node-pty, or external services; their tests need fixtures/mocks built in DA-012. They are implemented but their native paths are unproven by an automated test as of this item.
- DA-002's larger ask — reimplementing the web-only flagship platforms and the in-console GHDB / private-cloud generator natively (DA-001 GAP rows 1, 6, 9, 20) — is NOT started; those remain external-browser links.
