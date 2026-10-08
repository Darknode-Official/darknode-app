#!/usr/bin/env node
// DA-008 secret scan — run over the source tree (and, before packaging, over the
// built artifact) to fail on any hardcoded credential that is not explicitly
// allow-listed in security/secret-allowlist.json.
//
//   node scripts/scan-secrets.mjs [root]        # default root: repo root
//   node scripts/scan-secrets.mjs dist          # scan a build output
//
// Exit 0 = clean, 1 = findings. Findings are printed with the secret masked.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const { scanTree } = require(join(repoRoot, "lib", "secret", "scan.js"));

const root = resolve(process.argv[2] || repoRoot);
// never scan our own test fixtures (they contain intentional sample secrets)
const ignoreDirs = new Set([".git", "node_modules", "dist", "out", "build", ".nexus", "coverage", "test"]);

const { files, findings } = scanTree(root, { ignoreDirs });
if (!findings.length) {
  process.stdout.write(`secret-scan: clean (${files} files scanned under ${root})\n`);
  process.exit(0);
}
process.stdout.write(`secret-scan: ${findings.length} finding(s) in ${files} files under ${root}\n\n`);
for (const f of findings) process.stdout.write(`  ${f.file}:${f.line}  [${f.rule}]  ${f.masked}\n`);
process.stdout.write(`\nIf a finding is an intentionally-shipped value, add it to security/secret-allowlist.json.\n`);
process.exit(1);
