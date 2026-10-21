// Unit tests for lib/cve.js — NVD response normalization (CVSS vector + score
// breakdown), and CISA KEV matching. Fully offline; fixtures mimic the real
// NVD 2.0 and KEV JSON shapes.
import { test, group, assert } from "../harness.mjs";
import C from "../../lib/cve.js";

const NVD = {
  totalResults: 2,
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2021-44228",
        published: "2021-12-10T10:15:00.000",
        descriptions: [{ lang: "en", value: "Log4Shell JNDI RCE" }, { lang: "es", value: "otra" }],
        references: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
        metrics: {
          cvssMetricV31: [{ cvssData: { baseScore: 10.0, baseSeverity: "CRITICAL", vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H" } }],
        },
      },
    },
    {
      cve: {
        id: "CVE-2000-0001",
        published: "2000-01-01T00:00:00.000",
        descriptions: [{ lang: "en", value: "old one" }],
        metrics: { cvssMetricV2: [{ cvssData: { baseScore: 5.0, vectorString: "AV:N/AC:L/Au:N/C:P/I:P/A:P" }, baseSeverity: "MEDIUM" }] },
      },
    },
  ],
};

group("cve: normalizeNvd", () => {
  test("total + list length", () => {
    const r = C.normalizeNvd(NVD);
    assert.equal(r.total, 2);
    assert.equal(r.list.length, 2);
  });
  test("prefers English description", () => {
    assert.equal(C.normalizeNvd(NVD).list[0].desc, "Log4Shell JNDI RCE");
  });
  test("extracts v3.1 score, severity, vector and version", () => {
    const c = C.normalizeNvd(NVD).list[0];
    assert.equal(c.score, 10.0);
    assert.equal(c.sev, "CRITICAL");
    assert.equal(c.vector, "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H");
    assert.equal(c.cvssVersion, "3.1");
  });
  test("falls back to v2 metric with its severity", () => {
    const c = C.normalizeNvd(NVD).list[1];
    assert.equal(c.score, 5.0);
    assert.equal(c.sev, "MEDIUM");
    assert.equal(c.cvssVersion, "2.0");
  });
  test("collects references (capped)", () => {
    assert.equal(C.normalizeNvd(NVD).list[0].refs.length, 2);
  });
  test("empty data -> empty list, total 0", () => {
    const r = C.normalizeNvd({});
    assert.equal(r.total, 0);
    assert.deepEqual(r.list, []);
  });
});

group("cve: KEV matching", () => {
  const kev = C.buildKevIndex([
    { cveID: "CVE-2021-44228", dateAdded: "2021-12-10", dueDate: "2021-12-24", knownRansomwareCampaignUse: "Known", requiredAction: "Patch", vulnerabilityName: "Log4Shell" },
  ]);
  test("index keyed case-insensitively", () => {
    assert.ok(kev.get("cve-2021-44228".toUpperCase()));
  });
  test("markKev flags exploited CVEs and leaves others alone", () => {
    const list = C.normalizeNvd(NVD).list;
    C.markKev(list, kev);
    assert.ok(list[0].kev);
    assert.equal(list[0].kev.ransomware, "Known");
    assert.equal(list[0].kev.dateAdded, "2021-12-10");
    assert.equal(list[1].kev, undefined);
  });
  test("markKev tolerates a null index", () => {
    const list = C.normalizeNvd(NVD).list;
    assert.equal(C.markKev(list, null)[0].kev, undefined);
  });
});

group("cve: pickMetric ordering", () => {
  test("newest version wins when several are present", () => {
    const m = C.pickMetric({
      cvssMetricV2: [{ cvssData: { baseScore: 1 } }],
      cvssMetricV31: [{ cvssData: { baseScore: 9 } }],
    });
    assert.equal(m.version, "3.1");
    assert.equal(m.entry.cvssData.baseScore, 9);
  });
});
