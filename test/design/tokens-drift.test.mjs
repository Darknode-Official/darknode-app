// DA-004 token-drift guard.
//
// Enforces the single-source-of-truth rule: design/tokens.css is canonical
// (extracted from darknode-web). Any desktop token (renderer/styles.css) that
// shares a name with a canonical token MUST hold the canonical value, UNLESS it
// is listed in design/tokens-exceptions.json (the shrinking baseline of known,
// pre-existing forks). A new divergence fails; a baseline entry that no longer
// diverges also fails (so the baseline cannot rot).
import { test, group, assert } from "../harness.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Parse the first block matching `selector` into { --token: value }.
function parseTokens(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = css.match(re);
  const out = {};
  if (!m) return out;
  for (const decl of m[1].split(";")) {
    const mm = decl.match(/\s*(--[a-z0-9-]+)\s*:\s*(.+)\s*$/i);
    if (mm) out[mm[1]] = mm[2].trim().replace(/\s*\/\*.*?\*\/\s*/g, "").trim();
  }
  return out;
}

const canonCss = readFileSync(join(root, "design", "tokens.css"), "utf8");
const deskCss = readFileSync(join(root, "renderer", "styles.css"), "utf8");
const exceptions = JSON.parse(readFileSync(join(root, "design", "tokens-exceptions.json"), "utf8"));

const THEMES = [["dark", ":root"], ["light", ':root[data-theme="light"]']];

group("design: tokens.css is the canonical source of truth", () => {
  test("canonical dark block defines the core palette + scales", () => {
    const C = parseTokens(canonCss, ":root");
    for (const t of ["--bg", "--txt", "--acc", "--acc-2", "--ok", "--bad", "--warn", "--sp-4", "--fs-base", "--r-md", "--z-modal", "--ease"]) {
      assert.ok(C[t], `canonical token ${t} missing from design/tokens.css`);
    }
  });
  test("canonical light block overrides the themeable tokens", () => {
    const L = parseTokens(canonCss, ':root[data-theme="light"]');
    for (const t of ["--bg", "--card", "--txt", "--acc"]) assert.ok(L[t], `canonical light token ${t} missing`);
  });
});

group("design: no desktop token forks the canonical value (beyond baseline)", () => {
  for (const [theme, sel] of THEMES) {
    test(`${theme}: shared tokens match canonical except the documented baseline`, () => {
      const C = parseTokens(canonCss, sel);
      const D = parseTokens(deskCss, sel);
      const baseline = exceptions[theme] || {};
      const shared = Object.keys(C).filter((k) => k in D);
      const diverged = shared.filter((k) => C[k] !== D[k]);

      // 1. Every actual divergence must be in the baseline (no NEW forks).
      const undocumented = diverged.filter((k) => !(k in baseline));
      assert.equal(undocumented.length, 0,
        `${theme}: undocumented token fork(s): ${undocumented.map((k) => `${k} (desktop ${D[k]} != canonical ${C[k]})`).join("; ")}`);

      // 2. Every baseline entry must still diverge (baseline cannot rot).
      const stale = Object.keys(baseline).filter((k) => !diverged.includes(k));
      assert.equal(stale.length, 0,
        `${theme}: baseline entries no longer divergent, remove them: ${stale.join(", ")}`);

      // 3. Baseline values must describe reality (catch drift that dodges name match).
      for (const k of Object.keys(baseline)) {
        if (D[k] !== undefined) assert.equal(D[k], baseline[k].desktop, `${theme} ${k}: baseline desktop value stale`);
        assert.equal(C[k], baseline[k].canonical, `${theme} ${k}: baseline canonical value stale`);
      }
    });
  }
});
