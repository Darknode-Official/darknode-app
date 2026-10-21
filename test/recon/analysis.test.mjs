// Unit tests for lib/recon/analysis.js — pure SPF/DMARC/DKIM/CAA/DNSSEC parsing
// and VALUE-based HTTP security-header scoring. Fully offline.
import { test, group, assert } from "../harness.mjs";
import A from "../../lib/recon/analysis.js";

group("recon: analysis — SPF", () => {
  test("missing SPF is reported, not faked", () => {
    const r = A.parseSpf([["v=something else"]]);
    assert.equal(r.present, false);
    assert.ok(r.issues.length >= 1);
  });
  test("strict -all SPF has no issues", () => {
    const r = A.parseSpf([["v=spf1 include:_spf.google.com -all"]]);
    assert.equal(r.present, true);
    assert.equal(r.all, "-all");
    assert.deepEqual(r.issues, []);
  });
  test("+all is flagged as insecure", () => {
    const r = A.parseSpf(["v=spf1 +all"]);
    assert.equal(r.all, "+all");
    assert.ok(r.issues.some((i) => /\+all/.test(i)));
  });
  test("an include ending in 'all' does not mask the real -all policy", () => {
    const r = A.parseSpf(["v=spf1 include:firewall.example.com -all"]);
    assert.equal(r.all, "-all", "the -all term is the policy, not the 'all' inside 'firewall'");
    assert.deepEqual(r.issues, [], "a locked-down domain is not reported as wide-open");
  });
  test("duplicate SPF records flagged", () => {
    const r = A.parseSpf([["v=spf1 -all"], ["v=spf1 ~all"]]);
    assert.ok(r.issues.some((i) => /multiple/i.test(i)));
  });
  test("counts DNS-querying mechanisms", () => {
    const r = A.parseSpf(["v=spf1 include:a include:b a mx -all"]);
    assert.equal(r.lookups, 4);
  });
});

group("recon: analysis — DMARC", () => {
  test("p=reject with rua has no issues", () => {
    const r = A.parseDmarc([["v=DMARC1; p=reject; rua=mailto:x@y.com"]]);
    assert.equal(r.present, true);
    assert.equal(r.policy, "reject");
    assert.deepEqual(r.issues, []);
  });
  test("p=none is flagged monitoring-only", () => {
    const r = A.parseDmarc(["v=DMARC1; p=none; rua=mailto:x@y.com"]);
    assert.ok(r.issues.some((i) => /p=none|monitor/i.test(i)));
  });
  test("pct<100 under an enforcing policy is flagged", () => {
    const r = A.parseDmarc(["v=DMARC1; p=quarantine; pct=50; rua=mailto:x@y.com"]);
    assert.equal(r.pct, 50);
    assert.ok(r.issues.some((i) => /pct=50/.test(i)));
  });
  test("missing DMARC reported", () => {
    assert.equal(A.parseDmarc(null).present, false);
  });
});

group("recon: analysis — DKIM", () => {
  test("live selector detected", () => {
    const r = A.parseDkim([{ selector: "google", records: [["v=DKIM1; k=rsa; p=MIGf..."]] }]);
    assert.equal(r.present, true);
    assert.equal(r.count, 1);
    assert.equal(r.selectors[0].keyType, "rsa");
  });
  test("revoked (empty p=) selector counted but not live", () => {
    const r = A.parseDkim([{ selector: "old", records: [["v=DKIM1; p="]] }]);
    assert.equal(r.present, false);
    assert.equal(r.selectors[0].revoked, true);
  });
  test("no selectors -> not present", () => {
    assert.equal(A.parseDkim([]).present, false);
  });
});

group("recon: analysis — CAA & DNSSEC", () => {
  test("CAA issuers extracted", () => {
    const r = A.summarizeCaa([{ critical: 0, issue: "letsencrypt.org" }, { critical: 0, issuewild: "digicert.com" }]);
    assert.equal(r.present, true);
    assert.deepEqual(r.issuers, ["letsencrypt.org", "digicert.com"]);
  });
  test("no CAA -> absent", () => {
    assert.equal(A.summarizeCaa([]).present, false);
  });
  test("DNSSEC enabled when AD flag set", () => {
    const r = A.summarizeDnssec({ ok: true, enabled: true, ad: true, dnskey: false });
    assert.equal(r.enabled, true);
  });
  test("DNSSEC unknown when probe failed (honest null, not false)", () => {
    const r = A.summarizeDnssec({ ok: false, enabled: null, error: "resolver 500" });
    assert.equal(r.enabled, null);
    assert.ok(/unavailable|determined/i.test(r.note));
  });
});

group("recon: analysis — header scoring (value-based)", () => {
  test("missing headers score 0", () => {
    const r = A.scoreHeaders({});
    assert.equal(r.score, 0);
    assert.equal(r.grade, "F");
    assert.equal(r.max, 6);
  });
  test("a weak HSTS scores less than a strong one", () => {
    const weak = A.scoreHeaders({ "strict-transport-security": "max-age=100" });
    const strong = A.scoreHeaders({ "strict-transport-security": "max-age=31536000; includeSubDomains; preload" });
    const w = weak.checks.find((c) => c.key === "strict-transport-security");
    const s = strong.checks.find((c) => c.key === "strict-transport-security");
    assert.ok(s.points > w.points, "strong HSTS must outscore weak HSTS");
    assert.equal(s.points, 1);
  });
  test("CSP with unsafe-inline loses points vs a clean CSP", () => {
    const unsafe = A.scoreHeaders({ "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'" });
    const clean = A.scoreHeaders({ "content-security-policy": "default-src 'self'" });
    const u = unsafe.checks.find((c) => c.key === "content-security-policy");
    const c = clean.checks.find((c) => c.key === "content-security-policy");
    assert.ok(c.points > u.points);
    assert.ok(/unsafe/i.test(u.note));
  });
  test("X-Content-Type-Options must be nosniff for full credit", () => {
    const good = A.scoreHeaders({ "x-content-type-options": "nosniff" }).checks.find((c) => c.key === "x-content-type-options");
    const bad = A.scoreHeaders({ "x-content-type-options": "whatever" }).checks.find((c) => c.key === "x-content-type-options");
    assert.equal(good.points, 1);
    assert.equal(bad.points, 0.5);
  });
  test("a fully hardened site grades A", () => {
    const r = A.scoreHeaders({
      "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=()",
    });
    assert.equal(r.grade, "A");
    assert.equal(r.score, 6);
  });
  test("header keys are matched case-insensitively", () => {
    const r = A.scoreHeaders({ "X-Frame-Options": "SAMEORIGIN" });
    assert.equal(r.checks.find((c) => c.key === "x-frame-options").points, 1);
  });
});

group("recon: analysis — SPF a/mx CIDR lookups + DMARC pct", () => {
  test("a/cidr and mx/cidr mechanisms count toward the 10-lookup limit", () => {
    const terms = Array.from({ length: 6 }, () => "a/24 mx/24").join(" ");
    const r = A.parseSpf([["v=spf1 " + terms + " ~all"]]);
    assert.equal(r.lookups, 12);
    assert.ok(r.issues.some((i) => /10 DNS-lookup/.test(i)));
  });
  test("a non-numeric DMARC pct defaults to 100, not NaN", () => {
    const r = A.parseDmarc([["v=DMARC1; p=reject; pct=foo; rua=mailto:x@test.darknode.ai"]]);
    assert.equal(r.pct, 100);
    assert.notOk(r.issues.some((i) => /only applies to/.test(i)));
  });
});
