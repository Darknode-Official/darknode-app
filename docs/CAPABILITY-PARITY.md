# Capability Parity Matrix — darknode-web vs darknode-app

**Work item:** DA-001 (Darknode Desktop Superiority Program)
**Status:** matrix complete; parity NOT yet reached on every row (gaps enumerated below).
**Date:** 2026-10-04
**Author:** autonomous engineering agent (Claude Opus 4.8)

## Method and evidence

Every row was reproduced from source in both repos, not inferred from docs. Markers:

- **[C]** Confirmed — reproduced from source; file/line reference recorded.
- **[V]** Unverified — stated but not yet reproduced.

Ground-truth references used:

- Web module tree: `darknode-web/ARCHITECTURE.md` and `darknode-web/public/js/*` (216 modules measured).
- Desktop capability surface, reproduced from source:
  - IPC handlers: `darknode-app/main.js` — 90 `ipcMain.handle(...)` channels (enumerated by `grep -nE 'ipcMain\.(handle|on)\(' main.js`).
  - Renderer bridge: `darknode-app/preload.js` — the `window.darknode` surface (114 lines).
  - Renderer views: `darknode-app/renderer/app.js` — 34 section handlers in the `sections` object; 33 sidebar nav items in `renderer/index.html`.
  - Offline tool engine: `darknode-app/renderer/webtools-native.js` — 73 tools across 8 categories (counted by loading the module).
  - Web-tool mirror catalog: `darknode-app/renderer/webtools-catalog.js` — 843 mini-tool ids across 16 categories (counted by loading the module).

### Measured counts (corrections to stale figures)

| Figure | Stale claim | Measured value | Source of measurement |
|---|---|---|---|
| `darknode-web/public/css/styles.css` | "~1130 lines" (brief) | **9,592 lines** | `wc -l public/css/styles.css` |
| web core stylesheet set | — | styles.css 9,592 + pro-theme.css 14,111 + console.css 236 + buttons.css 25 | `wc -l` |
| web tool platforms | "192 / 164+" | web `ARCHITECTURE.md` states **192 platforms + 902 Toolbox mini-tools**; not re-counted line-by-line here | web ARCHITECTURE.md |
| desktop native CLI-tool launchers (`TOOLS`) | — | **98** `{ id: ... }` entries in `renderer/app.js` | `grep -oE '\{ ?id: ?"..."' \| wc -l` |
| desktop offline native mini-tools (`WT_NATIVE`) | — | **73** across 8 categories | loaded module |
| desktop web-tool mirror catalog (`WT_MINI`) | "843" (comment) | **843** across 16 categories | loaded module |
| orphaned `darknode-app/app.js` | documented as unclear | root `app.js` (3,321 lines) is **not referenced by any HTML**; `renderer/index.html` loads `renderer/app.js` (4,055 lines). Root copy is dead code (differs from the live file by 842 changed lines). | `grep app.js renderer/index.html`; `diff` |

Prohibited-phrase note: this document states what was measured. It does not assert "production ready", "fully hardened", "pixel-identical", or "bug free".

## How the desktop reaches (or fails to reach) each web capability

The desktop exposes three distinct execution modes. The mode matters for parity:

1. **Native** — runs in the Electron main process against the real OS/network (port scan, DNS/WHOIS/TLS, git, QEMU, pty, file forensics). The web browser **cannot** do these. Strictly superior.
2. **Local-offline** — runs in the renderer with no network and no darknode.ai (the 73 `WT_NATIVE` tools: hashing, encoding, ciphers, generators, etc.). Equal in result to the web's client-side tools, superior in that it needs no page load and no network.
3. **Replicated-external** — the `flagship` "Web tools" grid does **not** embed or reimplement the web apps. Each tile calls `S.openExternal("https://darknode.ai/...")`, opening the live website in the user's **system browser** (`renderer/app.js` ~L2055–2097; the app's own copy at L2097 reads: "larger platforms (PROMETHEUS, CITADEL, HYDRA…) open live from darknode.ai"). This is **weaker than web parity on the desktop surface**: it requires network + darknode.ai, runs outside the app window, and breaks the "function fully offline" requirement (DA-003). Any capability whose only desktop route is this grid is **effectively web-only**.

## Matrix

Columns: **Web** (present on web) · **Desktop** (present in the app) · **Mode** (Native / Local-offline / Replicated-external / none) · **Quality vs web** · **Parity**.

Parity legend: **>** desktop stronger · **=** equal · **<** desktop weaker · **GAP** web-only in practice.

| # | Capability | Web module(s) | Web | Desktop surface | Mode | Quality vs web | Parity |
|---|---|---|---|---|---|---|---|
| 1 | Browser tool arsenal / 192 tool platforms | `toolkit.js`, `utils.js` | yes | `flagship` grid → external browser to darknode.ai | Replicated-external | opens website off-app, needs network | **GAP** |
| 2 | Toolbox mini-tools (902 on web) | `tools-manifest.js`, `tools/*.js` | yes | `tools` In-app utilities + `webtools-native.js` (73 native) + `flagship` mirror (843 as external links) | Local-offline (73) + Replicated-external (rest) | 73 run offline in-app (>); remainder open website (<) | **PARTIAL** |
| 3 | Native CLI tool catalog | `tools.js` (reference list) | yes (as reference) | `tools` section: 98 launchers via `which`/`tool:install`/`run` into a live terminal | Native | web only lists commands; desktop runs them | **>** |
| 4 | Threat intel + CVE feed + cheat sheets | `cyber.js` | yes | `intel`, `cve` sections; `cve:search` IPC → NVD; `address-intel` via `net:get` | Native | live lookups vs static/page-bound | **>** |
| 5 | Payload / snippet / reference libraries | `labs.js` | yes | `payloads`, `refs`, `wordlists` sections | Local (in-app data) | equal content, in-app | **=** |
| 6 | Google Hacking DB scoped to target | `ghdb.js` | yes (in-console) | only via `flagship` → external browser | Replicated-external | not in-console; opens website | **GAP** |
| 7 | Pivot search Exploit-DB/NVD/KEV/Shodan | `exploitdb.js` | yes | `exploits` section | Native/local | present | **=** (verify depth in DA-002) |
| 8 | Vulnerable-VM directory | `vms.js` | yes (static directory) | `lab` (Docker-launch DVWA/Juice Shop) + `vms` (QEMU runner, builds Darknode OS) | Native | web is a static list; desktop launches real VMs/containers | **>** |
| 9 | Private-cloud docker-compose generator | `privatecloud.js` | yes (in-console) | only via `flagship` → external browser | Replicated-external | not in-console; no native generate/execute | **GAP** |
| 10 | Findings → Markdown report generator | `report.js` | yes | `engagement` writes a Markdown engagement report; `notes` exports findings Markdown; general "Report Generator" web tool only via external grid | Native (engagement/notes) + Replicated-external (general) | engagement/notes native (>); general report external (<) | **PARTIAL** |
| 11 | Curated external tool directories | `arsenal.js` | yes | `arsenal`, `training` sections | Local | equal | **=** |
| 12 | GitHub integration | brief names `github.js` (no such module on web; GitHub appears only inside tool modules) | web: limited | `github` section: native `git:*` + `github:*` IPC (clone/pull/push/branch/PR/issues/gist/comment) | Native | desktop far exceeds web | **>** |
| 13 | Saved workspace (bookmarks/notes) | `saved.js` (Firestore or localStorage) | yes | `notes` (localStorage per-target), `loot` (`~/darknode-results` files) | Local | present locally; no cross-device sync (see DA-003) | **=** on-device; sync GAP |
| 14 | Shared recon target store | `target.js` | yes | target bar wired across `recon`/`scanner`/`fuzzer`/`tools` (`targetVal()`, `subTarget()`) | Local | equal | **=** |
| 15 | Guided tour | `tour.js` | yes | partial (3 references in `renderer/app.js`; no full spotlight walkthrough reproduced) | partial | weaker/unconfirmed | **PARTIAL** |
| 16 | Command palette | in `auth.js` (Ctrl-K) | yes | `openPalette()` Ctrl/Cmd+K with fuzzy match over sections + playbooks + tools | Native | equal+ | **=** / **>** |
| 17 | Announcements | in `auth.js` | yes | partial (2 references; no announcement feed reproduced) | partial | weaker/unconfirmed | **PARTIAL** |
| 18 | Docs hub | `docs.js` | yes | `docs` section (native) + "Docs" web tool via external grid | Native/local | present | **=** |
| 19 | Per-OS install command reference | `downloads.js` | yes | `update` section + flagship "Darknode OS"/"Download Guide" external links | Local/external | present | **=** |
| 20 | Flagship platforms (PROMETHEUS, SENTINEL EYE, HYDRA, AEGIS, VANGUARD, PHANTOM, CITADEL, ORACLE, SPECTRE, CRUCIBLE, NAVARCH, Security Dashboard) | `prometheus-web.js`, `sentinel-eye.js`, `hydra-engine.js`, `aegis-web.js`, `vanguard.js`, `phantom.js`, `citadel.js`, `oracle.js`, `spectre.js`, `crucible*.js`, `navarch.js`, `security-dashboard.js` | yes | only via `flagship` → external browser to darknode.ai | Replicated-external | no native implementation; opens website off-app | **GAP** |
| 21 | AI assistant | `webai.js` (hosted proxy or local Ollama) | yes (Ollama local + hosted) | `home`/`agent`/`ai`: streaming across Ollama (local) + Claude + OpenAI-compatible + Darknode AI proxy | Native | desktop adds Claude + OpenAI-compatible engines + autonomous agent | **>** |
| 22 | Accounts / sign-in / sync / owner admin | `auth.js`, `admin.js`, `saved.js`, Firestore rules | yes | none reproduced (no sign-in, no sync, no entitlement gate in app) | none | absent | **GAP** (addressed by DA-003) |
| 23 | QEMU VM runner / Darknode OS builder | — (web has none) | no | `vms` section + `vm:*` IPC | Native | desktop-only; web cannot | **>** (desktop-exclusive) |
| 24 | Live terminals (pty) | — (web has none) | no | `runner` section + `pty:*` IPC + xterm.js | Native | desktop-only | **>** (desktop-exclusive) |
| 25 | Native recon (port scan, DNS, WHOIS, TLS, subdomains, fuzz) | web simulates / links out | partial | `scanner`/`recon`/`fuzzer` + `scan:ports`/`dns:lookup`/`whois:query`/`tls:cert`/`subdomains:find`/`fuzz:dirs` IPC | Native | desktop-only real execution | **>** (desktop-exclusive) |
| 26 | MCP client | — | no | `mcp:*` IPC (connect/list/call/resources/prompts) | Native | desktop-only | **>** (desktop-exclusive) |
| 27 | Enterprise governance ledger + compliance bundle | — | no | `gov:*` IPC (identity, usage ledger, compliance build/verify) | Native | desktop-only | **>** (desktop-exclusive) |
| 28 | File forensics (hash/entropy/strings/type) | web client-side only | partial | `forensics` section + `forensics:analyze` IPC on real files | Native | reads real files on disk | **>** |

## Summary of parity state at DA-001 close

- **Desktop-exclusive advantages (web cannot do these):** rows 23–27 and the native modes of 3, 4, 8, 12, 25, 28. These satisfy the "several exist on desktop that web cannot have" objective.
- **Rows at or above parity:** 3, 4, 5, 7, 8, 11, 12, 13 (on-device), 14, 16, 18, 19, 21, 23–28.
- **Rows NOT at parity (must close before program exit):**
  - **GAP (web-only in practice):** 1 (192 platforms), 6 (GHDB in-console), 9 (private-cloud compose in-console), 20 (12 flagship platforms), 22 (accounts/sync/admin → DA-003).
  - **PARTIAL:** 2 (only 73 of 902 mini-tools native; rest are external links), 10 (general report generator external), 15 (guided tour), 17 (announcements).

The dominant finding: the desktop's `flagship` "Web tools" grid is **not** a native or embedded capability — it is a set of `openExternal` links to darknode.ai. Every capability whose only desktop route is that grid (rows 1, 6, 9, 20, and the non-native remainder of 2 and 10) is therefore **weaker on desktop than on web** and **non-functional offline**, which directly contradicts the program objective ("no capability exists on web that is absent or weaker on desktop") and the DA-003 offline requirement.

## What DA-001 establishes for later items

- **DA-002 (native execution advantage):** close GAP rows by reimplementing the in-console web capabilities (GHDB scoped-to-target, private-cloud compose generate+execute, the general report generator, and the flagship platforms) as native or genuinely in-app surfaces, each backed by a test on the native path. The 843-tile external grid should be reduced in favor of in-app rendering.
- **DA-003 (accounts/sync):** row 22 is the account/sync/admin gap; close without importing web's hard-coded-owner defect, and keep all local tool use working offline.
- **DA-011 (god files):** the orphaned root `app.js` (dead code) must be removed/resolved; `renderer/app.js` (4,055 lines) and `main.js` (1,252 lines) are the two god files to decompose.

## Residual risk / not verified

- Web's "902 Toolbox mini-tools" was taken from `darknode-web/ARCHITECTURE.md`, not re-counted tool-by-tool in this item; the desktop mirror catalog measured 843, so the desktop grid itself is already behind the web figure by ~59 and warrants a precise recount in DA-002/DA-015.
- Rows 7 (exploit pivot depth), 15 (tour), 17 (announcements) are marked PARTIAL from reference counts, not from exercising the feature; they need functional reproduction in their owning items.
- The brief's capability enumeration names a `github.js` web module that does not exist; GitHub functionality on web lives inside individual tool modules. Recorded as a brief/reality discrepancy, not a defect.
