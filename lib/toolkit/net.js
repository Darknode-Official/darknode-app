// Darknode toolkit — network parsing & address math.
//
// Pure, dual-environment. IPv4 integer/CIDR math, address classification
// (RFC 1918 private, loopback, link-local, CGNAT, documentation, multicast,
// reserved), MAC parsing, a common-port lookup, and URL / JWT dissection
// (decode only — JWTs are NOT verified). Uses the global URL constructor
// (present in Node 20 and the browser).
//
// Verified by test/toolkit/net.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- IPv4 integer math --------------------------------------------------
  function isValidIpv4(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
    if (!m) return false;
    return m.slice(1).every((o) => { const n = +o; return n >= 0 && n <= 255 && String(n) === o; }); // no leading zeros
  }
  function ipv4ToInt(ip) {
    if (!isValidIpv4(ip)) throw new Error("invalid IPv4 address");
    return String(ip).trim().split(".").reduce((acc, o) => ((acc << 8) | +o) >>> 0, 0) >>> 0;
  }
  const intToIpv4 = (n) => { n = n >>> 0; return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); };

  // ---- Classification -----------------------------------------------------
  const _in = (ip, cidr) => cidrContains(cidr, ip);
  function classifyIpv4(ip) {
    if (!isValidIpv4(ip)) throw new Error("invalid IPv4 address");
    const first = +String(ip).split(".")[0];
    const loopback = _in(ip, "127.0.0.0/8");
    const priv = _in(ip, "10.0.0.0/8") || _in(ip, "172.16.0.0/12") || _in(ip, "192.168.0.0/16");
    const linkLocal = _in(ip, "169.254.0.0/16");
    const cgnat = _in(ip, "100.64.0.0/10");
    const multicast = first >= 224 && first <= 239;
    const documentation = _in(ip, "192.0.2.0/24") || _in(ip, "198.51.100.0/24") || _in(ip, "203.0.113.0/24");
    const benchmark = _in(ip, "198.18.0.0/15");
    const thisNet = _in(ip, "0.0.0.0/8");
    const reserved = first >= 240 || multicast || documentation || benchmark || thisNet || cgnat;
    let klass = "E";
    if (first < 128) klass = "A"; else if (first < 192) klass = "B"; else if (first < 224) klass = "C"; else if (first < 240) klass = "D";
    const global = !(priv || loopback || linkLocal || reserved);
    let type = "public";
    if (loopback) type = "loopback"; else if (priv) type = "private"; else if (linkLocal) type = "link-local";
    else if (cgnat) type = "shared (CGNAT)"; else if (multicast) type = "multicast"; else if (documentation) type = "documentation";
    else if (benchmark) type = "benchmark"; else if (first >= 240) type = "reserved"; else if (thisNet) type = "this-network";
    return { version: 4, ip: String(ip).trim(), int: ipv4ToInt(ip), class: klass, private: priv, loopback, linkLocal, cgnat, multicast, documentation, reserved, global, type };
  }

  // ---- CIDR ---------------------------------------------------------------
  function maskFromPrefix(prefix) {
    prefix = +prefix;
    if (!(prefix >= 0 && prefix <= 32)) throw new Error("invalid prefix length");
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  }
  function cidrParse(cidr) {
    const [addr, pfxRaw] = String(cidr).trim().split("/");
    if (pfxRaw === undefined) throw new Error("not a CIDR (missing /prefix)");
    const prefix = +pfxRaw;
    const mask = maskFromPrefix(prefix);
    const ipInt = ipv4ToInt(addr);
    const network = (ipInt & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const total = prefix === 0 ? 4294967296 : Math.pow(2, 32 - prefix);
    const usable = prefix >= 31 ? total : total - 2;
    const first = prefix >= 31 ? network : (network + 1) >>> 0;
    const last = prefix >= 31 ? broadcast : (broadcast - 1) >>> 0;
    return {
      cidr: intToIpv4(network) + "/" + prefix, prefix, mask: intToIpv4(mask),
      network: intToIpv4(network), broadcast: intToIpv4(broadcast),
      first: intToIpv4(first), last: intToIpv4(last),
      total, usable, wildcard: intToIpv4(~mask >>> 0),
    };
  }
  function cidrContains(cidr, ip) {
    const [addr, pfxRaw] = String(cidr).trim().split("/");
    const mask = maskFromPrefix(pfxRaw === undefined ? 32 : +pfxRaw);
    return ((ipv4ToInt(addr) & mask) >>> 0) === ((ipv4ToInt(ip) & mask) >>> 0);
  }

  // ---- MAC ----------------------------------------------------------------
  function macParse(mac) {
    const hex = String(mac).replace(/[^0-9a-fA-F]/g, "");
    if (hex.length !== 12) throw new Error("invalid MAC address");
    const octets = hex.match(/.{2}/g).map((h) => parseInt(h, 16));
    const first = octets[0];
    return {
      normalized: octets.map((o) => o.toString(16).padStart(2, "0")).join(":"),
      oui: octets.slice(0, 3).map((o) => o.toString(16).padStart(2, "0").toUpperCase()).join(":"),
      multicast: (first & 0x01) === 1,
      locallyAdministered: (first & 0x02) === 2,
      broadcast: octets.every((o) => o === 0xff),
    };
  }

  // ---- Ports --------------------------------------------------------------
  const PORTS = {
    20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 67: "dhcp", 68: "dhcp",
    69: "tftp", 80: "http", 88: "kerberos", 110: "pop3", 111: "rpcbind", 123: "ntp", 135: "msrpc",
    137: "netbios-ns", 138: "netbios-dgm", 139: "netbios-ssn", 143: "imap", 161: "snmp", 162: "snmptrap",
    179: "bgp", 389: "ldap", 443: "https", 445: "smb", 465: "smtps", 500: "isakmp", 514: "syslog",
    515: "printer", 587: "submission", 631: "ipp", 636: "ldaps", 873: "rsync", 989: "ftps-data", 990: "ftps",
    993: "imaps", 995: "pop3s", 1080: "socks", 1433: "mssql", 1521: "oracle", 1723: "pptp", 2049: "nfs",
    2082: "cpanel", 2375: "docker", 2376: "docker-tls", 3306: "mysql", 3389: "rdp", 4444: "metasploit",
    5060: "sip", 5432: "postgresql", 5601: "kibana", 5900: "vnc", 5985: "winrm", 5986: "winrm-tls",
    6379: "redis", 6443: "kubernetes-api", 8080: "http-proxy", 8443: "https-alt", 9000: "sonarqube",
    9200: "elasticsearch", 9300: "elasticsearch", 11211: "memcached", 27017: "mongodb",
  };
  function portInfo(port) {
    const p = +port;
    if (!(p >= 0 && p <= 65535)) throw new Error("port out of range");
    const range = p < 1024 ? "well-known" : p < 49152 ? "registered" : "dynamic/ephemeral";
    return { port: p, service: PORTS[p] || null, range };
  }

  // ---- URL ----------------------------------------------------------------
  function parseUrl(url) {
    const u = new URL(String(url));
    const params = {};
    u.searchParams.forEach((v, k) => { if (k in params) { params[k] = [].concat(params[k], v); } else params[k] = v; });
    return {
      protocol: u.protocol.replace(/:$/, ""), username: u.username, password: u.password,
      host: u.host, hostname: u.hostname, port: u.port || null, path: u.pathname,
      query: u.search.replace(/^\?/, ""), params, fragment: u.hash.replace(/^#/, ""), origin: u.origin,
    };
  }

  // ---- JWT (decode only, NOT verified) -----------------------------------
  function _b64urlToStr(s) {
    let b = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = (typeof atob === "function") ? atob(b) : Buffer.from(b, "base64").toString("binary");
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function parseJwt(token) {
    const parts = String(token).trim().split(".");
    if (parts.length < 2) throw new Error("not a JWT");
    const header = JSON.parse(_b64urlToStr(parts[0]));
    const payload = JSON.parse(_b64urlToStr(parts[1]));
    const out = { header, payload, signature: parts[2] || null, verified: false };
    if (payload.exp) out.expired = Date.now() >= payload.exp * 1000;
    return out;
  }

  return {
    isValidIpv4, ipv4ToInt, intToIpv4, classifyIpv4,
    maskFromPrefix, cidrParse, cidrContains,
    macParse, portInfo, parseUrl, parseJwt,
  };
});
