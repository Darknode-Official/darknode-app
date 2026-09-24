// Test entrypoint: discover every *.test.mjs under test/, import them (which
// registers their cases via the harness), then run. Exits non-zero on any
// failure so it can gate CI.  Usage: `node test/run.mjs`  or  `npm test`.
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { run } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function findTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

const files = findTests(here).sort();
for (const f of files) await import(pathToFileURL(f).href);

process.stdout.write(`Discovered ${files.length} test file(s).\n\n`);
const ok = await run();
process.exit(ok ? 0 : 1);
