// Darknode toolkit — CVSS v3.0 / v3.1 base score calculator.
//
// Pure, dual-environment. Parses a CVSS v3.x base vector string and computes
// the Base Score and severity rating exactly per the FIRST.org specification
// (https://www.first.org/cvss/v3.1/specification-document, section 7.1).
// Base metrics only (no Temporal/Environmental). The v3.0 and v3.1 base
// formulas are identical except for the Roundup function, which this handles.
//
// Verified by test/toolkit/cvss.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Metric value → numeric weight. PR depends on Scope, handled below.
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    C: { H: 0.56, L: 0.22, N: 0 },
    I: { H: 0.56, L: 0.22, N: 0 },
    A: { H: 0.56, L: 0.22, N: 0 },
    PR_U: { N: 0.85, L: 0.62, H: 0.27 }, // Scope Unchanged
    PR_C: { N: 0.85, L: 0.68, H: 0.5 },  // Scope Changed
  };
  const BASE_KEYS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"];
  const ALLOWED = { AV: "NALP", AC: "LH", PR: "NLH", UI: "NR", S: "UC", C: "HLN", I: "HLN", A: "HLN" };

  // CVSS v3.1 Roundup: smallest one-decimal number >= input, computed on
  // integers to avoid binary-float edge cases (spec Appendix A).
  function roundup31(input) {
    const n = Math.round(input * 100000);
    if (n % 10000 === 0) return n / 100000;
    return (Math.floor(n / 10000) + 1) / 10;
  }
  // CVSS v3.0 rounding: round to one decimal, half up.
  function round30(input) { return Math.round(input * 10) / 10; }

  // Severity rating band for a base score (identical in v3.0 and v3.1).
  function severity(score) {
    if (score <= 0) return "None";
    if (score < 4.0) return "Low";
    if (score < 7.0) return "Medium";
    if (score < 9.0) return "High";
    return "Critical";
  }

  // Parse "CVSS:3.1/AV:N/AC:L/..." (the "CVSS:" prefix is optional) into a
  // { version, metrics } object. Throws on malformed input or a bad value so
  // callers get a clear error instead of a silently wrong score.
  function parseVector(vector) {
    if (typeof vector !== "string" || !vector.trim()) throw new Error("empty CVSS vector");
    const parts = vector.trim().split("/").filter(Boolean);
    let version = "3.1";
    const metrics = {};
    for (const part of parts) {
      const [rawKey, rawVal] = part.split(":");
      if (rawKey === undefined || rawVal === undefined) throw new Error("malformed segment: " + part);
      const key = rawKey.trim().toUpperCase(), val = rawVal.trim().toUpperCase();
      if (key === "CVSS") { version = rawVal.trim(); continue; }
      if (!ALLOWED[key]) continue;            // ignore unknown/temporal/env metrics
      if (!ALLOWED[key].includes(val)) throw new Error("invalid value for " + key + ": " + rawVal);
      metrics[key] = val;
    }
    if (version !== "3.0" && version !== "3.1") throw new Error("unsupported CVSS version: " + version);
    const missing = BASE_KEYS.filter((k) => !(k in metrics));
    if (missing.length) throw new Error("missing base metric(s): " + missing.join(", "));
    return { version, metrics };
  }

  // Compute the base score for a parsed { version, metrics } (or a raw vector
  // string). Returns { version, metrics, baseScore, severity, impact,
  // exploitability, vector }.
  function score(input) {
    const parsed = typeof input === "string" ? parseVector(input) : input;
    const m = parsed.metrics;
    const version = parsed.version || "3.1";
    const scopeChanged = m.S === "C";
    const pr = (scopeChanged ? W.PR_C : W.PR_U)[m.PR];

    const iscBase = 1 - (1 - W.C[m.C]) * (1 - W.I[m.I]) * (1 - W.A[m.A]);
    const impact = scopeChanged
      ? 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15)
      : 6.42 * iscBase;
    const exploitability = 8.22 * W.AV[m.AV] * W.AC[m.AC] * pr * W.UI[m.UI];

    const roundup = version === "3.0" ? round30 : roundup31;
    let base;
    if (impact <= 0) base = 0;
    else base = roundup(Math.min((scopeChanged ? 1.08 : 1) * (impact + exploitability), 10));

    return {
      version,
      metrics: m,
      baseScore: base,
      severity: severity(base),
      impact: Math.round(impact * 10) / 10,
      exploitability: Math.round(exploitability * 10) / 10,
      vector: "CVSS:" + version + "/" + BASE_KEYS.map((k) => k + ":" + m[k]).join("/"),
    };
  }

  return { parseVector, score, severity };
});
