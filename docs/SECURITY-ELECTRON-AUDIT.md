# Electron Hardening Audit — DA-007 ([V] -> reproduced)

**Status:** PARTIAL. BrowserWindow + IPC + navigation + CSP verified from source
([C]); one S0 SSRF bypass (redirect-following) found and fixed with tests; the
full renderer-side escape suite is NOT YET EXECUTED (needs a running Electron
instance, unavailable here).
**Date:** 2026-10-04

## BrowserWindow / webContents configuration (main.js `createWindow`, `web-contents-created`)

| Control | Required | Found | Evidence |
|---|---|---|---|
| contextIsolation | on | **on** | `webPreferences.contextIsolation: true` (main.js ~L43) [C] |
| nodeIntegration | off | **off** | `nodeIntegration: false` (~L44) [C] |
| sandbox | on | **on** | `sandbox: true` (~L45) [C] |
| webSecurity | on | **on (default)** | not set; Electron defaults to true. Recommend setting it explicitly. [C] |
| remote module | absent | **absent** | `@electron/remote` not imported anywhere [C] |
| renderer CSP | strict | **present** | `index.html` meta CSP: `default-src 'self'; script-src 'self'; connect-src 'self' https://api.github.com https://gmail.googleapis.com https://www.googleapis.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'` [C] |
| window.open | blocked | **denied** | main window `setWindowOpenHandler(() => ({action:"deny"}))` (~L59); `web-contents-created` opens only http/https via `shell.openExternal`, denies the rest (~L66-69) [C] |
| navigation | locked to app | **locked** | `will-navigate` preventDefault for any non-`file://` URL (~L55-57) [C] |
| `<webview>` guests | no Node, isolated | **hardened on attach** | `webviewTag: true` is enabled for the Browser tab, but `will-attach-webview` deletes `preload`, and forces `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` (~L70) [C] |
| `shell.openExternal` | validated | **validated** | `openExternal` IPC opens only `http:`/`https:` (main.js), rejects `file:`/custom schemes [C] |

Residual: `webviewTag:true` remains an attack surface (the Browser tab loads
arbitrary remote origins into a guest). The guest is sandboxed and Node-free, but
the set of origins it may load is not allow-listed; a dedicated review of the
Browser section is recommended (tracked as residual, not fixed here).

## IPC surface

90 `ipcMain.handle` channels; `preload.js` exposes a fixed typed `window.darknode`
surface (114 lines) and no raw `ipcRenderer`. Spot audit of the
externally-reachable network channels found the SSRF issue below. A per-channel
authorization/path-traversal/argument-injection review of all 90 handlers
(esp. `run`, `agent:exec`, `git:*`, `fs:*`, `vm:*`) is NOT yet complete and is
carried as residual for the rest of DA-007.

## S0 FOUND AND FIXED — SSRF via redirect following

**Finding [C]:** `net:get` and `http:request` validated only the *initial* URL's
host against the private/loopback/link-local/metadata guard, then called `fetch`
with `redirect: "follow"` (explicit in `http:request`; the default in `net:get`).
A permitted public host could therefore return `302 Location:
http://169.254.169.254/...` (or `http://127.0.0.1/...`) and `fetch` would follow
it to the internal target with no re-check — a renderer-reachable SSRF to cloud
metadata and loopback services.

**Fix:** extracted the guard to `lib/net/guard.js` and routed both handlers
through `safeFetch`, which uses `redirect: "manual"` and re-validates the host of
**every** hop (initial + each `Location`) before following, bounded to 5 hops.
Diff: `main.js` (both handlers now call `safeFetch`; inline guard removed),
`lib/net/guard.js` (new).

**Regression tests** (`test/net/guard.test.mjs`, 35 cases, deterministic — DNS +
fetch injected, no network):
- `isPrivateHost` escape suite: blocks IPv4 private/loopback/metadata/CGNAT,
  IPv6 `::1`/`::`/`fe80`/`fc`/`fd`, IPv4-mapped `::ffff:`, decimal `2130706433`,
  hex `0x7f000001`, malformed octets, empty (fail-closed); allows real public IPs
  and names.
- `validateUrl`: rejects non-http(s) schemes; blocks a public NAME that resolves
  to a private IP (DNS-rebind at resolve time).
- `safeFetch`: **blocks a public->private redirect and does not fetch the private
  target**; follows a public->public redirect; blocks a private initial host
  before any fetch; stops after too many redirects.

### Verification

```
$ npm test
  ok   net.guard: safeFetch re-validates every redirect hop › blocks a redirect from a public host to a private host
  ... (35 net.guard cases)
150 passed, 0 failed  (150 tests, 179ms)
$ node --check main.js   # passes
```

## Residual risk / NOT YET EXECUTED

- **DNS rebinding (TOCTOU):** `safeFetch` validates by resolving the host, then
  `fetch` resolves again independently; a sub-TTL rebinding server could still
  differ between the two lookups. Fully closing it requires pinning the resolved
  IP and connecting to that IP with the Host header preserved (a custom agent).
  Documented, not fixed.
- **Renderer-side escape suite (DA-007 acceptance):** attempts from the renderer
  to reach Node, invoke arbitrary IPC, escape navigation, and bypass the SSRF
  guard end-to-end require launching Electron; this environment has no display.
  The SSRF portion is covered by unit tests against the real guard logic; the
  Node/IPC/navigation escape attempts are NOT YET EXECUTED and must run in an
  Electron E2E harness (DA-012).
- The per-handler authorization/injection review of all 90 IPC channels is
  incomplete.
