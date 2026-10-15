// CIDR coverage tests for lib/scope/authz.js — authorizing an IPv4 block must
// cover its member addresses (so a /24 scan needs one authorization), without
// broadening to anything outside the block.
import { test, group, assert } from "../harness.mjs";
import A from "../../lib/scope/authz.js";

const { targetCovered, ipInCidr, validateRecord } = A;

const rec = (targets) => validateRecord({
  targets, activityClasses: ["active"],
  from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z", attestedBy: "owner",
}).record;

group("scope: ipInCidr", () => {
  test("member and non-member addresses", () => {
    assert.equal(ipInCidr("10.0.0.5", "10.0.0.0/24"), true);
    assert.equal(ipInCidr("10.0.1.5", "10.0.0.0/24"), false);
  });
  test("/32 matches only itself", () => {
    assert.equal(ipInCidr("10.0.0.7", "10.0.0.7/32"), true);
    assert.equal(ipInCidr("10.0.0.8", "10.0.0.7/32"), false);
  });
  test("/0 matches everything", () => {
    assert.equal(ipInCidr("8.8.8.8", "0.0.0.0/0"), true);
  });
  test("malformed CIDR covers nothing (fail closed)", () => {
    assert.equal(ipInCidr("10.0.0.1", "10.0.0.0/40"), false);
    assert.equal(ipInCidr("10.0.0.1", "not-a-cidr"), false);
    assert.equal(ipInCidr("not-an-ip", "10.0.0.0/24"), false);
  });
});

group("scope: targetCovered with CIDR records", () => {
  test("a /24 authorization covers an address inside it", () => {
    assert.equal(targetCovered(rec(["10.0.0.0/24"]), "10.0.0.42"), true);
  });
  test("it does NOT cover an address outside the block", () => {
    assert.equal(targetCovered(rec(["10.0.0.0/24"]), "10.0.1.42"), false);
  });
  test("host:port on the target still resolves against the CIDR", () => {
    assert.equal(targetCovered(rec(["10.0.0.0/24"]), "10.0.0.42:8080"), true);
  });
  test("CIDR records never match hostnames", () => {
    assert.equal(targetCovered(rec(["10.0.0.0/24"]), "example.com"), false);
  });
  test("a plain-host record is unaffected (no accidental CIDR behavior)", () => {
    assert.equal(targetCovered(rec(["example.com"]), "example.com"), true);
    assert.equal(targetCovered(rec(["example.com"]), "10.0.0.1"), false);
  });
});
