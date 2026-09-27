// Unit tests for lib/toolkit/cvss.js — base score against published vectors.
import { test, group, assert } from "../harness.mjs";
import C from "../../lib/toolkit/cvss.js";

group("cvss: known real-world vectors", () => {
  const cases = [
    // [vector, expectedScore, expectedSeverity, note]
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0, "Critical", "Log4Shell CVE-2021-44228"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "Critical", "classic critical RCE"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5, "High", "Heartbleed-style info leak"],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8, "High", "local privilege escalation"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "Medium", "reflected XSS"],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", 5.5, "Medium", "local info disclosure"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0.0, "None", "no impact"],
  ];
  for (const [vec, expScore, expSev, note] of cases) {
    test(note + " → " + expScore, () => {
      const r = C.score(vec);
      assert.equal(r.baseScore, expScore);
      assert.equal(r.severity, expSev);
    });
  }
});

group("cvss: scope + version", () => {
  test("v3.0 scores the same as v3.1 for these vectors", () => {
    assert.equal(C.score("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H").baseScore, 9.8);
    assert.equal(C.score("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H").baseScore, 10.0);
  });
  test("scope-changed applies the 1.08 multiplier and PR_C weights", () => {
    const u = C.score("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:L").baseScore;
    const c = C.score("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:L").baseScore;
    assert.ok(c > u, "changed scope scores higher than unchanged for the same impacts");
  });
  test("computed vector round-trips the base metrics", () => {
    assert.equal(C.score("AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H").vector,
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
  });
});

group("cvss: parsing + errors", () => {
  test("prefix optional, case-insensitive, ignores temporal metrics", () => {
    const r = C.score("cvss:3.1/av:n/ac:l/pr:n/ui:n/s:u/c:h/i:h/a:h/E:F/RL:O");
    assert.equal(r.baseScore, 9.8);
  });
  test("missing metric throws", () => {
    assert.throws(() => C.score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H"));
  });
  test("invalid value throws", () => {
    assert.throws(() => C.parseVector("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"));
  });
  test("unsupported version throws", () => {
    assert.throws(() => C.parseVector("CVSS:2.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"));
  });
  test("empty input throws", () => {
    assert.throws(() => C.parseVector(""));
  });
});
