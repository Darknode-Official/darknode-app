// Darknode recon — pure analysis helpers (dual-environment, no I/O).
//
// Turns raw lookup data that the main process gathers (real DNS TXT/CAA records,
// HTTP response headers, a DNSSEC probe result) into graded, explainable
// findings. Everything here is pure: given the same inputs it returns the same
// output, so it runs identically in the Electron main process, the renderer
// (attached to window.DarknodeToolkit), and the Node test harness.
//
//   parseSpf(txt)          -> { present, record, all, issues }
//   parseDmarc(txt)        -> { present, record, policy, pct, rua, issues }
//   parseDkim(selectors)   -> { present, count, selectors:[...] }
//   summarizeCaa(records)  -> { present, issuers, records }
//   summarizeDnssec(probe) -> { enabled, ad, dnskey, note }
//   scoreHeaders(headers)  -> { score, max, grade, checks:[...] }
//
// Verified by test/recon/analysis.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // resolveTxt() yields string[][] (each record is an array of character-string
  // chunks that must be concatenated). Normalize anything we are handed into a
  // flat list of whole-record strings.
  function flattenTxt(txt) {
    if (!Array.isArray(txt)) return [];
    return txt.map((r) => (Array.isArray(r) ? r.join("") : String(r == null ? "" : r)));
  }

  // --- SPF (apex TXT, v=spf1) -------------------------------------------------
  function parseSpf(txt) {
    const recs = flattenTxt(txt).filter((r) => /^v=spf1\b/i.test(r.trim()));
    const issues = [];
    if (!recs.length) return { present: false, record: null, all: null, issues: ["no SPF record published"] };
    if (recs.length > 1) issues.push("multiple SPF records found (RFC 7208 forbids this — mail may be rejected)");
    const record = recs[0].trim();
    // Match the `all` MECHANISM as a whole space-delimited term, not a substring — otherwise an
    // earlier term whose label ends in "all" (include:firewall., a:marshall., paywall.) is mistaken
    // for the policy and a locked-down -all/~all is misreported as the wide-open +all.
    const allTok = record.split(/\s+/).find((t) => /^[-~?+]?all$/i.test(t));
    const all = allTok ? (/^[-~?+]/.test(allTok) ? allTok[0] : "+") + "all" : null;
    if (!all) issues.push("no 'all' mechanism — SPF enforcement is undefined");
    else if (all === "+all") issues.push("'+all' permits any sender (effectively no protection)");
    else if (all === "?all") issues.push("'?all' is neutral — provides no real enforcement");
    // Count DNS-querying terms (RFC 7208 §4.6.4 caps these at 10): include, a,
    // mx, ptr, exists (bare or with a :domain) and the redirect modifier.
    let lookups = 0;
    for (const term of record.split(/\s+/)) {
      // Allow the dual-CIDR forms a/24 and mx//64 (and a:dom/24): the mechanism may
      // be followed by ':', '/', or end-of-term and still costs one DNS lookup.
      if (/^[+\-~?]?(include|a|mx|ptr|exists)([:/]|$)/i.test(term)) lookups++;
      else if (/^redirect=/i.test(term)) lookups++;
    }
    if (lookups > 10) issues.push("exceeds the 10 DNS-lookup limit (" + lookups + ") — SPF will permerror");
    return { present: true, record, all, lookups, issues };
  }

  // --- DMARC (_dmarc TXT, v=DMARC1) ------------------------------------------
  function parseDmarc(txt) {
    const recs = flattenTxt(txt).filter((r) => /^v=DMARC1\b/i.test(r.trim()));
    const issues = [];
    if (!recs.length) return { present: false, record: null, policy: null, issues: ["no DMARC record published"] };
    const record = recs[0].trim();
    const tag = (name) => { const m = record.match(new RegExp("\\b" + name + "\\s*=\\s*([^;]+)", "i")); return m ? m[1].trim() : null; };
    const policy = (tag("p") || "").toLowerCase() || null;
    const sub = (tag("sp") || "").toLowerCase() || null;
    const pctNum = tag("pct") != null ? parseInt(tag("pct"), 10) : 100;
    const pct = Number.isFinite(pctNum) ? pctNum : 100; // a non-numeric pct would leak NaN and silence the pct<100 warning
    const rua = tag("rua");
    if (!policy) issues.push("no 'p=' policy tag — record is invalid");
    else if (policy === "none") issues.push("policy 'p=none' only monitors; it does not block spoofed mail");
    if (policy && policy !== "none" && pct < 100) issues.push("pct=" + pct + " — policy only applies to " + pct + "% of mail");
    if (!rua) issues.push("no 'rua=' aggregate-report address — you receive no DMARC reports");
    return { present: true, record, policy, subPolicy: sub, pct, rua, issues };
  }

  // --- DKIM (selector._domainkey TXT, v=DKIM1) -------------------------------
  // `selectors` is [{ selector, records:[...] }] gathered by probing common
  // selector names in the main process.
  function parseDkim(selectors) {
    const found = [];
    for (const s of (selectors || [])) {
      if (!s) continue; // a malformed/partial probe result can leave a null entry — skip it, don't abort every selector
      const recs = flattenTxt(s.records);
      const rec = recs.find((r) => /(^|;)\s*v\s*=\s*dkim1/i.test(r) || /(^|;)\s*p\s*=/i.test(r));
      if (!rec) continue;
      const kt = (rec.match(/\bk\s*=\s*([a-z0-9]+)/i) || [])[1] || "rsa";
      const pm = rec.match(/\bp\s*=\s*([^;]*)/i);
      const pub = pm ? pm[1].replace(/\s+/g, "") : "";
      found.push({ selector: s.selector, keyType: kt.toLowerCase(), revoked: pm != null && pub === "" });
    }
    const live = found.filter((f) => !f.revoked);
    return { present: live.length > 0, count: live.length, selectors: found };
  }

  // --- CAA --------------------------------------------------------------------
  // resolveCaa() yields [{ critical, issue|issuewild|iodef }].
  function summarizeCaa(records) {
    if (!Array.isArray(records) || !records.length) return { present: false, issuers: [], records: [] };
    const issuers = [];
    for (const r of records) {
      if (!r) continue; // guard a null element so one bad record doesn't throw away the whole CAA summary
      const v = r.issue || r.issuewild;
      if (v) { const ca = String(v).split(";")[0].trim(); if (ca && !issuers.includes(ca)) issuers.push(ca); }
    }
    return { present: true, issuers, records };
  }

  // --- DNSSEC -----------------------------------------------------------------
  // `probe` is the main-process DoH result: { ok, enabled, ad, dnskey, error }.
  function summarizeDnssec(probe) {
    probe = probe || {};
    if (probe.ok === false || probe.enabled == null) {
      return { enabled: null, ad: !!probe.ad, dnskey: !!probe.dnskey, note: probe.error ? "check unavailable: " + probe.error : "DNSSEC status could not be determined" };
    }
    return {
      enabled: !!probe.enabled, ad: !!probe.ad, dnskey: !!probe.dnskey,
      note: probe.enabled
        ? (probe.dnskey ? "DNSKEY present and validated (AD flag set)" : "resolver returned the Authenticated-Data flag")
        : "zone is not signed — responses can be spoofed",
    };
  }

  // --- HTTP security-header scoring (VALUE-based, not mere presence) ----------
  // headers: a map of lowercase header name -> value string.
  // Each check earns 0..1 points; score is the sum out of max (=number of checks).
  function scoreHeaders(headers) {
    const h = {};
    for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = String(headers[k] == null ? "" : headers[k]);
    const checks = [];
    const push = (key, label, present, points, value, note) =>
      checks.push({ key, label, present: !!present, points: Math.max(0, Math.min(1, Math.round(points * 100) / 100)), value: value || "", note: note || "" });

    // HSTS — reward a long max-age and includeSubDomains, not just presence.
    {
      const v = h["strict-transport-security"];
      if (v == null) push("strict-transport-security", "HSTS", false, 0, "", "missing — no transport-security enforcement");
      else {
        const ma = parseInt((v.match(/max-age\s*=\s*(\d+)/i) || [])[1] || "0", 10);
        const sub = /includesubdomains/i.test(v), pre = /preload/i.test(v);
        let p = 0.4, note = [];
        if (ma >= 15552000) { p += 0.4; } else if (ma > 0) { note.push("max-age " + ma + "s is below the recommended 15552000s (180d)"); } else { note.push("max-age is 0 or absent"); }
        if (sub) p += 0.2; else note.push("no includeSubDomains");
        if (pre && sub && ma >= 31536000) p = 1;
        push("strict-transport-security", "HSTS", true, p, v, note.join("; ") || "strong policy");
      }
    }
    // CSP — a policy that still allows unsafe-inline/eval is only half-credit.
    {
      const v = h["content-security-policy"];
      if (v == null) push("content-security-policy", "Content-Security-Policy", false, 0, "", "missing — no content-injection defense");
      else {
        const unsafe = /unsafe-inline|unsafe-eval/i.test(v);
        // A bare `*` (not `*.host`) or `data:` in any script-executing directive is as
        // permissive as it is in default-src — checking only default-src over-graded a
        // policy that locks default-src but opens e.g. `script-src *`.
        const wildcard = /\b(default-src|script-src|object-src|frame-src|base-uri)[^;]*\*(?!\.)/i.test(v) || /\b(default-src|script-src)\s+[^;]*\bdata:/i.test(v);
        let p = 0.5, note = [];
        if (!unsafe) p += 0.3; else note.push("allows unsafe-inline/unsafe-eval");
        if (!wildcard) p += 0.2; else note.push("uses a wildcard/data: source");
        push("content-security-policy", "Content-Security-Policy", true, p, v, note.join("; ") || "no unsafe sources");
      }
    }
    // X-Frame-Options — DENY/SAMEORIGIN are the only meaningful values.
    {
      const v = h["x-frame-options"];
      if (v == null) push("x-frame-options", "X-Frame-Options", false, 0, "", "missing — clickjacking not prevented (unless CSP frame-ancestors is set)");
      else { const u = v.trim().toUpperCase(); const good = u === "DENY" || u === "SAMEORIGIN"; push("x-frame-options", "X-Frame-Options", true, good ? 1 : 0.5, v, good ? "" : "value '" + v + "' is not DENY/SAMEORIGIN"); }
    }
    // X-Content-Type-Options — must be nosniff.
    {
      const v = h["x-content-type-options"];
      if (v == null) push("x-content-type-options", "X-Content-Type-Options", false, 0, "", "missing — MIME sniffing not disabled");
      else { const good = /nosniff/i.test(v); push("x-content-type-options", "X-Content-Type-Options", true, good ? 1 : 0.5, v, good ? "" : "value is not 'nosniff'"); }
    }
    // Referrer-Policy — privacy-preserving values earn full credit.
    {
      const v = h["referrer-policy"];
      const strong = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];
      if (v == null) push("referrer-policy", "Referrer-Policy", false, 0, "", "missing — full referrer may leak cross-origin");
      else { const good = strong.includes(v.trim().toLowerCase()); push("referrer-policy", "Referrer-Policy", true, good ? 1 : 0.5, v, good ? "" : "'" + v + "' leaks referrer information"); }
    }
    // Permissions-Policy — presence of directives (empty value is near-useless).
    {
      const v = h["permissions-policy"] != null ? h["permissions-policy"] : h["feature-policy"];
      if (v == null) push("permissions-policy", "Permissions-Policy", false, 0, "", "missing — browser features not restricted");
      else { const has = v.trim().length > 0; push("permissions-policy", "Permissions-Policy", true, has ? 1 : 0.5, v, has ? "" : "empty policy"); }
    }

    const score = Math.round(checks.reduce((a, c) => a + c.points, 0) * 10) / 10;
    const max = checks.length;
    const ratio = max ? score / max : 0;
    const grade = ratio >= 0.95 ? "A" : ratio >= 0.8 ? "B" : ratio >= 0.6 ? "C" : ratio >= 0.4 ? "D" : "F";
    return { score, max, grade, checks };
  }

  return { flattenTxt, parseSpf, parseDmarc, parseDkim, summarizeCaa, summarizeDnssec, scoreHeaders };
});
