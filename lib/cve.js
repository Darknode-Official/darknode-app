// Darknode — pure CVE normalization + CISA KEV matching (dual-environment).
//
// The main process fetches the live NVD 2.0 API and the CISA Known-Exploited-
// Vulnerabilities catalog; this module turns those raw responses into a clean,
// explainable result set WITHOUT any network or disk I/O, so it runs in main,
// renderer, and the test harness identically.
//
//   normalizeNvd(data)         -> { total, list:[{ id, desc, score, sev, vector, cvssVersion, published, refs }] }
//   buildKevIndex(vulns)       -> Map(CVE-ID -> kev entry)
//   markKev(list, kevIndex)    -> same list with .kev set where applicable
//
// Verified by test/cve/cve.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Pick the richest CVSS metric block NVD returned, newest version first.
  function pickMetric(metrics) {
    const m = metrics || {};
    const order = ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"];
    for (const key of order) {
      if (Array.isArray(m[key]) && m[key][0]) {
        const version = key.replace("cvssMetric", "").replace("V", "").replace(/(\d)(\d)/, "$1.$2").replace(/^(\d)$/, "$1.0");
        return { entry: m[key][0], version };
      }
    }
    return null;
  }

  function normalizeOne(v) {
    const c = (v && v.cve) || {};
    const descs = c.descriptions || [];
    const desc = ((descs.find((x) => x && x.lang === "en") || descs[0] || {}) || {}).value || "";
    const picked = pickMetric(c.metrics);
    let score = "", sev = "", vector = "", cvssVersion = "";
    if (picked) {
      const d = picked.entry.cvssData || {};
      score = d.baseScore != null ? d.baseScore : "";
      sev = d.baseSeverity || picked.entry.baseSeverity || "";
      vector = d.vectorString || "";
      cvssVersion = picked.version;
    }
    const refs = (c.references || []).map((r) => r && r.url).filter(Boolean).slice(0, 8);
    return { id: c.id || "", desc, score, sev, vector, cvssVersion, published: (c.published || "").slice(0, 10), refs };
  }

  function normalizeNvd(data) {
    data = data || {};
    const list = (data.vulnerabilities || []).map(normalizeOne).filter((x) => x.id);
    return { total: data.totalResults != null ? data.totalResults : list.length, list };
  }

  // Build a fast lookup from the CISA KEV catalog's `vulnerabilities` array.
  function buildKevIndex(vulns) {
    const idx = new Map();
    for (const v of (vulns || [])) {
      if (v && v.cveID) idx.set(String(v.cveID).toUpperCase(), v);
    }
    return idx;
  }

  // Annotate each normalized CVE with its KEV entry (if actively exploited).
  function markKev(list, kevIndex) {
    if (!kevIndex || typeof kevIndex.get !== "function") return list || [];
    for (const c of (list || [])) {
      const hit = kevIndex.get(String(c.id).toUpperCase());
      if (hit) {
        c.kev = {
          dateAdded: hit.dateAdded || "",
          dueDate: hit.dueDate || "",
          ransomware: hit.knownRansomwareCampaignUse || "Unknown",
          action: hit.requiredAction || "",
          name: hit.vulnerabilityName || "",
        };
      }
    }
    return list || [];
  }

  return { pickMetric, normalizeOne, normalizeNvd, buildKevIndex, markKev };
});
