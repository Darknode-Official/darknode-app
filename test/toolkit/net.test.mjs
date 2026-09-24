// Unit tests for lib/toolkit/net.js — address math, classification, dissection.
import { test, group, assert } from "../harness.mjs";
import N from "../../lib/toolkit/net.js";

group("net: ipv4 int", () => {
  test("validation", () => {
    assert.ok(N.isValidIpv4("192.168.1.1"));
    assert.ok(N.isValidIpv4("0.0.0.0"));
    assert.ok(N.isValidIpv4("255.255.255.255"));
    assert.notOk(N.isValidIpv4("256.1.1.1"));
    assert.notOk(N.isValidIpv4("1.2.3"));
    assert.notOk(N.isValidIpv4("01.2.3.4")); // leading zero
    assert.notOk(N.isValidIpv4("1.2.3.4.5"));
  });
  test("int round-trip + known", () => {
    assert.equal(N.ipv4ToInt("0.0.0.0"), 0);
    assert.equal(N.ipv4ToInt("255.255.255.255") >>> 0, 0xffffffff);
    assert.equal(N.ipv4ToInt("192.168.1.1") >>> 0, 0xc0a80101);
    assert.equal(N.intToIpv4(0xc0a80101), "192.168.1.1");
  });
});

group("net: classification", () => {
  test("private / loopback / link-local / public", () => {
    assert.equal(N.classifyIpv4("10.1.2.3").type, "private");
    assert.equal(N.classifyIpv4("172.16.5.5").type, "private");
    assert.equal(N.classifyIpv4("192.168.0.1").type, "private");
    assert.equal(N.classifyIpv4("127.0.0.1").type, "loopback");
    assert.equal(N.classifyIpv4("169.254.1.1").type, "link-local");
    assert.equal(N.classifyIpv4("8.8.8.8").type, "public");
    assert.ok(N.classifyIpv4("8.8.8.8").global);
    assert.notOk(N.classifyIpv4("10.0.0.1").global);
  });
  test("special ranges + classes", () => {
    assert.equal(N.classifyIpv4("100.64.0.1").type, "shared (CGNAT)");
    assert.equal(N.classifyIpv4("224.0.0.1").type, "multicast");
    assert.equal(N.classifyIpv4("203.0.113.5").type, "documentation");
    assert.equal(N.classifyIpv4("10.0.0.1").class, "A");
    assert.equal(N.classifyIpv4("172.16.0.1").class, "B");
    assert.equal(N.classifyIpv4("192.168.0.1").class, "C");
  });
});

group("net: cidr", () => {
  test("/24 math", () => {
    const c = N.cidrParse("192.168.1.0/24");
    assert.equal(c.network, "192.168.1.0");
    assert.equal(c.broadcast, "192.168.1.255");
    assert.equal(c.first, "192.168.1.1");
    assert.equal(c.last, "192.168.1.254");
    assert.equal(c.mask, "255.255.255.0");
    assert.equal(c.total, 256);
    assert.equal(c.usable, 254);
  });
  test("normalizes host bits to network", () => {
    assert.equal(N.cidrParse("192.168.1.55/24").network, "192.168.1.0");
  });
  test("/31 and /32 edge cases", () => {
    assert.equal(N.cidrParse("10.0.0.0/32").total, 1);
    assert.equal(N.cidrParse("10.0.0.0/32").usable, 1);
    assert.equal(N.cidrParse("10.0.0.0/31").total, 2);
    assert.equal(N.cidrParse("10.0.0.0/31").usable, 2);
    assert.equal(N.cidrParse("0.0.0.0/0").total, 4294967296);
  });
  test("contains", () => {
    assert.ok(N.cidrContains("192.168.1.0/24", "192.168.1.200"));
    assert.notOk(N.cidrContains("192.168.1.0/24", "192.168.2.1"));
    assert.ok(N.cidrContains("10.0.0.0/8", "10.255.255.255"));
  });
});

group("net: mac / ports", () => {
  test("mac parse + flags", () => {
    const m = N.macParse("01:23:45:67:89:ab");
    assert.equal(m.normalized, "01:23:45:67:89:ab");
    assert.equal(m.oui, "01:23:45");
    assert.ok(m.multicast); // first octet 0x01, bit0 set
    assert.ok(N.macParse("ff-ff-ff-ff-ff-ff").broadcast);
    assert.ok(N.macParse("02:00:00:00:00:00").locallyAdministered);
  });
  test("mac accepts unseparated + rejects short", () => {
    assert.equal(N.macParse("0123456789ab").normalized, "01:23:45:67:89:ab");
    assert.throws(() => N.macParse("01:23:45"));
  });
  test("port lookup", () => {
    assert.equal(N.portInfo(443).service, "https");
    assert.equal(N.portInfo(22).range, "well-known");
    assert.equal(N.portInfo(50000).range, "dynamic/ephemeral");
    assert.equal(N.portInfo(9999).service, null);
    assert.throws(() => N.portInfo(70000));
  });
});

group("net: url / jwt", () => {
  test("url dissection", () => {
    const u = N.parseUrl("https://user:pw@ex.com:8443/a/b?x=1&y=2#frag");
    assert.equal(u.protocol, "https");
    assert.equal(u.hostname, "ex.com");
    assert.equal(u.port, "8443");
    assert.equal(u.path, "/a/b");
    assert.equal(u.params.x, "1");
    assert.equal(u.fragment, "frag");
    assert.equal(u.username, "user");
  });
  test("jwt decode (unverified) — standard sample", () => {
    const tok = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const j = N.parseJwt(tok);
    assert.equal(j.header.alg, "HS256");
    assert.equal(j.payload.name, "John Doe");
    assert.equal(j.payload.sub, "1234567890");
    assert.notOk(j.verified);
  });
  test("jwt rejects non-token", () => { assert.throws(() => N.parseJwt("nope")); });
});
