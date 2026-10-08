# DA-008 — Credential handling (S0)

Evidence marker: [C] Confirmed from source. Severity: S0 (plaintext credentials
readable by any process running as the same OS user, or by anyone who copies the
profile directory, is a credential-exposure gate; it blocks release until
closed).

## The gap (reproduced)

Every secret the app holds was stored in renderer `localStorage` as plaintext:
`s_anthropic_key`, `s_api_key`, `s_gh_token`, the Gmail OAuth `s_gmail_token` /
`s_gmail_refresh` / `s_gmail_client_secret`, and the threat-intel keys
`s_vt_key` / `s_abuseipdb_key` / `s_otx_key` / `s_abusech_key`. In Electron,
`localStorage` is an on-disk LevelDB under the user-data directory — unencrypted.
Reproduced by reading `renderer/app.js` (the `localStorage.getItem("s_*")`
sites) before this change.

Secondary exposure: secret values could be echoed into the main-process log, the
`agent:exec` transcript returned to the model, and the usage ledger — none of
which scrubbed them. (The `agent:exec` path already masked the injected
`autopass` value only.)

## What was built

### 1. OS-keychain-backed vault — `lib/secret/vault.js`

`createVault({ cwd, backend, allowInsecure })` encrypts each value with an
OS-backed key and writes only ciphertext to `<userData>/.nexus/secrets.enc`
(mode **0600**, written atomically via a temp file + rename). The crypto backend
is injected:

- In the Electron main process, `electronBackend(safeStorage, platform)` wraps
  Electron's `safeStorage` (macOS Keychain, Windows DPAPI, Linux
  libsecret/kwallet). The key is bound to the current OS user's keychain.
- In tests, a fake per-"user" backend models that binding so the cross-user
  property is reproducible without two real OS accounts.

**Fail-closed:** when OS-backed encryption is unavailable, `set()` refuses rather
than silently storing plaintext, unless the caller passes `allowInsecure` (which
is recorded per entry and surfaced by `list()` / `mode()`). `list()` returns
metadata only — never values.

### 2. Redaction — `lib/secret/redact.js`

A single scrubber with two layers: (a) **shape rules** (Anthropic/OpenAI key
prefixes, GitHub tokens, Google API keys, Slack tokens, AWS access-key ids, JWTs,
PEM private-key blocks, `Authorization`/`Bearer`/`x-apikey` headers, and
`name = value` assignments where the name looks secret-ish); and (b)
**registered literals** — every value the vault reads or writes is registered, so
even a secret with no recognizable shape is scrubbed wherever it appears. Deep
object/array walk; cycle-safe; idempotent; anchored rules so ordinary prose and
legitimate hashes are not mangled.

### 3. Output-channel wiring — `main.js`

- A redacting `console` wrapper is installed before anything logs; every
  `console.{log,info,warn,error,debug}` argument is scrubbed.
- `agent:exec` output (both the node-pty and the `child_process` paths) is run
  through `redactString` before being returned to the renderer/model.
- `gov:usage:append` deep-redacts the record before it is written to
  `usage.jsonl`.
- `secret:get` / `secret:set` register the plaintext with the redactor so it is
  scrubbed from all of the above.

### 4. Scanner — `lib/secret/scan.js` + `scripts/scan-secrets.mjs`

`scanTree(root)` reuses the high-precision shape rules to find hardcoded
credentials in the source tree (and, before packaging, in a build output).
Findings never include the full secret (masked to `first4…last2 (N chars)`).
`security/secret-allowlist.json` suppresses intentionally-shipped values
(substrings or RegExp sources). Run with `npm run scan:secrets`; exit 1 on any
finding.

### 5. Renderer adoption — `renderer/app.js` + `preload.js`

`preload.js` exposes `secretSet/Get/Has/List/Remove/Mode`. A `DnSecrets` layer
keeps secrets in the vault and only an in-memory session cache in the renderer:
on boot it migrates any legacy plaintext secret out of `localStorage` into the
vault and deletes the plaintext copy. The existing secret call sites (AI provider
keys, GitHub token, Gmail token/refresh/client-secret, threat-intel keys) read
through `DnSecrets.get` (sync; cache first, legacy `localStorage` only as a
transitional fallback) and write through `DnSecrets.set` (persists to the vault).

## One local user cannot read another's stored credentials

Mechanism: `safeStorage` encrypts with a key held in the current OS user's
keychain (Keychain / DPAPI / libsecret), so another OS user's `safeStorage`
cannot decrypt this file; file mode 0600 additionally denies other users read
access to the ciphertext at the filesystem layer.

Reproduced at the logic layer in `test/secret/vault.test.mjs`
("another OS user's backend cannot decrypt this user's secrets"): user A stores a
value; user B opens the same file with a different backend key and `get()`
returns `null`, while A still decrypts it. The 0600 mode is asserted by
("the secrets file is written mode 0600").

NOT YET EXECUTED (needs two real OS accounts + a real keychain, unavailable in
this environment): an end-to-end test on a packaged build where OS user B logs in
and confirms user A's real `safeStorage`-encrypted secrets are undecryptable.
Procedure: build the app; as user A, store a key and read back `secrets.enc`; as
user B on the same machine, run the app pointed at A's user-data dir and confirm
`secret:get` returns null and the file is unreadable (0600). The logic test above
reproduces the same property with the real-key binding modelled.

## Verification (actual output)

```
$ node --check main.js && node --check preload.js && node --check renderer/app.js \
    && node --check lib/secret/redact.js && node --check lib/secret/vault.js \
    && node --check lib/secret/scan.js && echo SYNTAX_OK
SYNTAX_OK

$ node test/run.mjs | tail -1
205 passed, 0 failed  (205 tests, 192ms)

$ npm run scan:secrets
secret-scan: clean (94 files scanned under <repo>)

# detection sanity (planted token in a temp file):
#   planted-leak.js:1  [github-token]  ghp_…12 (40 chars)
```

The source tree scans clean: the known ex-hardcoded free-tier VirusTotal/Shodan
keys are not present in this repo, so `security/secret-allowlist.json` is empty.

## Residual risk

- Renderer runtime behavior is NOT runtime-verified here (no display/GUI in this
  environment). The changes are additive and fall back to `localStorage` if the
  vault bridge is absent or hydration has not completed, so a secret read during
  the brief post-reload hydration window can momentarily return empty until the
  async hydrate finishes; call sites are user-triggered and run well after boot.
  S3. Needs a display to confirm end-to-end. Procedure: launch the app, save each
  key in Settings, confirm `secrets.enc` appears and `localStorage` no longer
  holds the plaintext, and that the features still authenticate.
- `safeStorage` on Linux depends on an available secret service
  (libsecret/kwallet). Where none is present, `isEncryptionAvailable()` is false
  and the vault fails closed (refuses to store) unless `allowInsecure` is set;
  the current renderer does not pass `allowInsecure`, so on such a box secret
  saves will not persist to the vault and fall back to `localStorage`. S2 —
  surfacing `secret:mode` in the UI so the operator knows protection is
  unavailable is not yet wired.
- Secrets still transit the preload IPC boundary in cleartext (renderer →
  main). This is in-process and inside the same trust boundary as the renderer
  itself; it is not an at-rest exposure. Documented, not changed.
- The shape rules catch recognizable token formats; a novel secret with no
  recognizable shape is scrubbed from output only once it is a registered
  literal (which the vault guarantees for anything it stores). A hardcoded novel
  secret that never enters the vault would pass the scanner. S3.
