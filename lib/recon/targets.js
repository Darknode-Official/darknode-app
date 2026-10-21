// Darknode recon — pure target & port expansion + result export (dual-env).
//
// The scanner UI hands raw operator input (a host, an IPv4 CIDR, or a mixed
// list) and a port spec; these helpers turn that into concrete, bounded,
// de-duplicated work — and surface every parse error instead of silently
// falling back to defaults. Pure, so the main process, the renderer, and the
// test harness all share one implementation.
//
//   expandTargets(input, {maxHosts}) -> { groups:[{token,hosts:[...]}], total, errors, truncated }
//   parsePortSpec(str)               -> { ports:[...]|null, error }
//   resultsToCsv(rows) / resultsToJson(rows, meta)
//
// Verified by test/recon/targets.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const isIpv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((o) => +o >= 0 && +o <= 255);
  // A conservative hostname check (labels, TLD). Not a validator of existence —
  // just enough to reject obvious garbage before we hand it to the resolver.
  const isHostname = (s) => /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(s);

  const ipToInt = (ip) => ip.split(".").reduce((a, o) => (a * 256 + (+o)) >>> 0, 0) >>> 0;
  const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

  // Expand a single "a.b.c.d/nn" IPv4 block into every address it contains.
  function expandCidr(cidr, remaining) {
    const m = cidr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
    if (!m || !isIpv4(m[1])) return { error: "invalid CIDR '" + cidr + "'" };
    const bits = +m[2];
    if (bits < 0 || bits > 32) return { error: "CIDR prefix out of range in '" + cidr + "'" };
    const base = ipToInt(m[1]);
    const size = bits === 0 ? 4294967296 : Math.pow(2, 32 - bits);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const net = (base & mask) >>> 0;
    const hosts = [];
    const take = Math.min(size, remaining);
    for (let i = 0; i < take; i++) hosts.push(intToIp((net + i) >>> 0));
    return { hosts, truncated: size > take };
  }

  // input: host | ip | cidr | a mixed comma/space/newline list of them.
  function expandTargets(input, opts) {
    opts = opts || {};
    const maxHosts = opts.maxHosts || 1024;
    const raw = String(input || "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const groups = [];
    const errors = [];
    const seen = new Set();
    let total = 0, truncated = false;
    for (let tok of raw) {
      tok = tok.replace(/^https?:\/\//i, "");
      if (!/\/\d+$/.test(tok)) tok = tok.split("/")[0]; // strip URL path but keep CIDR suffix
      tok = tok.replace(/:\d+$/, ""); // strip a trailing :port
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      if (/\/\d+$/.test(tok)) {
        const r = expandCidr(tok, maxHosts - total);
        if (r.error) { errors.push(r.error); continue; }
        if (r.truncated) truncated = true;
        const hosts = r.hosts;
        total += hosts.length;
        groups.push({ token: tok, hosts });
      } else if (isIpv4(tok) || isHostname(tok)) {
        if (total >= maxHosts) { truncated = true; continue; }
        total += 1;
        groups.push({ token: tok, hosts: [tok] });
      } else {
        errors.push("not a valid host, IP, or CIDR: '" + tok + "'");
      }
    }
    return { groups, total, errors, truncated };
  }

  // Parse a port spec: "80", "1-1024", "22,80,443", "1-100,443,8000-8100".
  // Returns a sorted, de-duplicated list, or an error string — never a silent
  // fallback.
  function parsePortSpec(str) {
    const s = String(str == null ? "" : str).trim();
    if (!s) return { ports: null, error: "enter a port or range (e.g. 1-1024, or 22,80,443)" };
    const set = new Set();
    for (const part of s.split(/[\s,]+/).filter(Boolean)) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const a = +range[1], b = +range[2];
        if (a < 1 || b > 65535 || a > 65535 || b < 1) return { ports: null, error: "ports must be 1-65535 (got '" + part + "')" };
        if (a > b) return { ports: null, error: "range start is greater than end: '" + part + "'" };
        if (b - a > 65535) return { ports: null, error: "range too large: '" + part + "'" };
        for (let p = a; p <= b; p++) set.add(p);
      } else if (/^\d+$/.test(part)) {
        const p = +part;
        if (p < 1 || p > 65535) return { ports: null, error: "port out of range (1-65535): '" + part + "'" };
        set.add(p);
      } else {
        return { ports: null, error: "invalid port token: '" + part + "'" };
      }
    }
    if (!set.size) return { ports: null, error: "no valid ports in '" + s + "'" };
    return { ports: [...set].sort((x, y) => x - y), error: null };
  }

  // rows: [{ host, port, service, banner }]
  function resultsToCsv(rows) {
    const esc = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; /* neutralize spreadsheet formula injection from untrusted banner text */ return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const out = ["host,port,service,banner"];
    for (const r of (rows || [])) out.push([r.host, r.port, r.service, r.banner].map(esc).join(","));
    return out.join("\n");
  }

  function resultsToJson(rows, meta) {
    return JSON.stringify(Object.assign({
      tool: "darknode.scanner",
      generatedAt: (meta && meta.generatedAt) || new Date().toISOString(),
      open: (rows || []).length,
    }, meta || {}, { results: rows || [] }), null, 2);
  }

  return { expandTargets, expandCidr, parsePortSpec, resultsToCsv, resultsToJson, isIpv4, isHostname, ipToInt, intToIp };
});
