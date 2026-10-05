// DO-014 — hardening-baseline conformance check (skeleton with real checks).
//
// Evaluates the hardening baseline against the declarative image definition and
// the repository. Checks that can be evaluated now run for real; checks that
// need a built image or real hardware are reported as NOT YET EVALUATED and do
// NOT count as passing (a negative/unknown result is reported as plainly as a
// positive one).
//
// Exit code: non-zero if any EVALUABLE check fails. NOT-YET-EVALUATED checks do
// not fail the run but are listed so the gap is visible.
//
// Run: node track-b/hardening/conformance-check.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import jsyaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACK_B = join(HERE, '..');
const IMAGE_DEF = join(TRACK_B, 'distro', 'darknode-os.image.yaml');
const BASELINE = join(HERE, 'baseline.yaml');

function loadYaml(p) { return jsyaml.load(readFileSync(p, 'utf8')); }

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// --- the real credential/secret scan (TOP PRIORITY, DO-014) ---------------
// Patterns for embedded secrets and known default/shared credentials. Scans
// text file CONTENT; comments that merely reference a key by *fingerprint*
// (no key material) are fine, which is how the image def points at KMS keys.
const SECRET_PATTERNS = [
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'generic-assigned-secret', re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{6,}/i },
  { id: 'default-credential', re: /\b(?:root:toor|admin:admin|user:user|kali:kali|changeme)\b/i },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
];
// Lines that are clearly placeholders/references, not real secrets.
const ALLOW = [
  /fingerprint/i, /reference only/i, /KMS|HSM|external-kms/, /NEVER|never in/i,
  /set at install/i, /-KEY"\s*#/, /signedByFingerprint/, /keyFingerprint/,
];

// DO-014 scopes this check to image CONTENT and CONFIGURATION inputs — the
// places a secret must never appear ("never plaintext config, never in the
// image"). Policy-engine SOURCE (.mjs/.js) is reviewed by SAST separately and
// is excluded here so an identifier literally named `secret` is not a finding.
const CONFIG_EXT = /\.(ya?ml|json|env|conf|cfg|ini|toml|sh|service|preseed|nspawn)$/;
function scanSecrets() {
  const files = walk(TRACK_B).filter((f) => CONFIG_EXT.test(f));
  const findings = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ALLOW.some((a) => a.test(line))) continue;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) findings.push({ file: relative(TRACK_B, f), line: i + 1, rule: p.id, text: line.trim().slice(0, 100) });
      }
    }
  }
  return findings;
}

// --- checks ----------------------------------------------------------------
function run() {
  const image = loadYaml(IMAGE_DEF);
  const baseline = loadYaml(BASELINE);
  const results = [];
  const add = (id, status, detail) => results.push({ id, status, detail });

  // 1. No default/shared credentials + no plaintext secrets (REAL, evaluable now)
  const findings = scanSecrets();
  add('noDefaultOrSharedCredentials', findings.length === 0 ? 'PASS' : 'FAIL',
    findings.length === 0 ? `scanned track-b/ — no embedded or default credentials`
      : `${findings.length} finding(s): ` + JSON.stringify(findings));
  add('secretsStore.neverPlaintextConfig', findings.length === 0 ? 'PASS' : 'FAIL',
    findings.length === 0 ? 'no plaintext secret material in configs' : 'see finding above');

  // 2. Encrypted storage by default (REAL, reads the image definition)
  const fde = image?.disk?.fullDiskEncryption?.enabled === true;
  add('encryptedStorageByDefault', fde ? 'PASS' : 'FAIL',
    `image.disk.fullDiskEncryption.enabled = ${image?.disk?.fullDiskEncryption?.enabled}`);

  // 3. MAC enforcing (REAL at config level; runtime needs an image)
  const macMode = baseline?.controls?.mandatoryAccessControl?.mode;
  add('mandatoryAccessControl(config)', macMode === 'enforcing' ? 'PASS' : 'FAIL',
    `baseline mandatoryAccessControl.mode = ${macMode}`);

  // 4. Package signing verification required (REAL, reads the image definition)
  const verifyPkgs = image?.signing?.packages?.verify === true;
  add('signedPackagesRequired', verifyPkgs ? 'PASS' : 'FAIL',
    `image.signing.packages.verify = ${image?.signing?.packages?.verify}`);

  // 5..N. Checks that need a built image or real hardware — NOT YET EVALUATED.
  for (const [id, c] of Object.entries(baseline?.controls || {})) {
    if (c && c.evaluable === false) {
      add(id, 'NOT_YET_EVALUATED', 'requires a built image / CI / real hardware');
    }
  }

  return results;
}

const results = run();
const pass = results.filter((r) => r.status === 'PASS');
const fail = results.filter((r) => r.status === 'FAIL');
const pending = results.filter((r) => r.status === 'NOT_YET_EVALUATED');

console.log('DO-014 hardening conformance — Darknode OS image definition\n');
for (const r of results) console.log(`  [${r.status.padEnd(16)}] ${r.id}\n      ${r.detail}`);
console.log(`\nsummary: ${pass.length} pass, ${fail.length} fail, ${pending.length} not-yet-evaluated`);

if (fail.length > 0) { console.error('\nFAIL: conformance gate not met'); process.exit(1); }
console.log('\nOK: all evaluable checks pass (pending checks require a build host / hardware)');
