// Minimal zero-dependency test harness for the Darknode desktop app.
//
// The app has no build step and no test framework; this gives us real, runnable
// unit tests on plain Node (`npm test` -> `node test/run.mjs`) for the pure
// logic in lib/toolkit/*. Test files import { test, group, assert } and register
// cases as a module side effect; run.mjs imports every *.test.mjs then calls
// run(). Kept in sync with the web repo's harness so tests read the same.

const cases = []; // { group, name, fn }
let currentGroup = "";

export function group(name, fn) {
  const prev = currentGroup;
  currentGroup = name;
  fn();
  currentGroup = prev;
}

export function test(name, fn) {
  cases.push({ group: currentGroup, name, fn });
}

function stringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

export const assert = {
  ok(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${stringify(v)}`); },
  notOk(v, msg) { if (v) throw new Error(msg || `expected falsy, got ${stringify(v)}`); },
  equal(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${stringify(a)} === ${stringify(b)}`); },
  notEqual(a, b, msg) { if (a === b) throw new Error(msg || `expected ${stringify(a)} !== ${stringify(b)}`); },
  deepEqual(a, b, msg) { if (!deepEqual(a, b)) throw new Error(msg || `deepEqual failed:\n  a=${stringify(a)}\n  b=${stringify(b)}`); },
  close(a, b, eps, msg) { if (Math.abs(a - b) > (eps ?? 1e-9)) throw new Error(msg || `expected ${a} ≈ ${b}`); },
  throws(fn, msg) {
    let threw = false; try { fn(); } catch (_) { threw = true; }
    if (!threw) throw new Error(msg || "expected function to throw");
  },
};

export async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (const c of cases) {
    const label = c.group ? `${c.group} › ${c.name}` : c.name;
    try {
      await c.fn();
      pass++;
      process.stdout.write(`  ok   ${label}\n`);
    } catch (err) {
      fail++;
      failures.push({ label, err });
      process.stdout.write(`  FAIL ${label}\n`);
    }
  }
  const ms = Date.now() - t0;
  process.stdout.write(`\n${pass} passed, ${fail} failed  (${cases.length} tests, ${ms}ms)\n`);
  if (failures.length) {
    process.stdout.write(`\nFailures:\n`);
    for (const f of failures) process.stdout.write(`\n• ${f.label}\n  ${f.err && f.err.stack ? f.err.stack.split("\n").slice(0, 4).join("\n  ") : f.err}\n`);
  }
  return fail === 0;
}
