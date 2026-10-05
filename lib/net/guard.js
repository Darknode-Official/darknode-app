// Darknode SSRF guard (main-process only) — DA-007.
//
// Shared by the net:get and http:request IPC handlers. Blocks requests whose
// host is loopback / link-local / private / cloud-metadata, defeats
// non-canonical IPv4 encodings and IPv4-mapped IPv6 by resolving through DNS,
// and — critically — RE-VALIDATES every redirect hop so a permitted public host
// cannot 3xx-redirect the fetch to an internal address.
//
// Verified by test/net/guard.test.mjs.

// True if the host string is (or denotes) a private/loopback/link-local/metadata
// address, or a suspicious bare-integer/hex literal. Fails closed on malformed.
function isPrivateHost(h) {
  h = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const mapped = h.match(/^::ffff:(.+)$/i);            // IPv4-mapped IPv6 -> check the v4 tail
  if (mapped) return isPrivateHost(mapped[1]);
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a > 255 || b > 255 || +m[3] > 255 || +m[4] > 255) return true; // malformed -> deny
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // Not a dotted-quad literal: any non-canonical numeric encoding (decimal/hex/octal/
  // short-form) is only reachable after DNS resolution -- the caller must also check the
  // RESOLVED address via resolvesToPrivate(). A bare integer/hex host here is denied.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  return false;
}

// Resolve a hostname; true if ANY resolved address is private. Defeats
// public-name -> private-IP and non-canonical encodings (dns canonicalizes).
// Fails closed (lookup failure => blocked). `deps.lookup` is injectable for tests.
async function resolvesToPrivate(host, deps = {}) {
  const lookup = deps.lookup || require("dns").promises.lookup;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address));
  } catch (_) { return true; }
}

// Validate a single URL's host against the guard. Returns null if allowed, or an
// error string if blocked/malformed.
async function validateUrl(url, deps = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return "bad url";
  let host;
  try { host = new URL(url).hostname; } catch (_) { return "bad url"; }
  const resolver = deps.resolvesToPrivate || resolvesToPrivate;
  if (isPrivateHost(host) || await resolver(host, deps)) return "blocked host (loopback/link-local/private not allowed)";
  return null;
}

// fetch that validates the initial URL AND every redirect hop. Follows up to
// maxHops redirects manually, re-checking each Location host. Throws on a blocked
// host, bad url, or too many redirects. `deps.fetch`/`deps.resolvesToPrivate`/
// `deps.lookup` are injectable for tests.
async function safeFetch(url, opts = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const maxHops = deps.maxHops == null ? 5 : deps.maxHops;
  let current = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    const bad = await validateUrl(current, deps);
    if (bad) throw new Error(bad);
    const r = await fetchImpl(current, Object.assign({}, opts, { redirect: "manual" }));
    const loc = r.status >= 300 && r.status < 400 && r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
    if (loc) { current = new URL(loc, current).toString(); continue; }
    return r;
  }
  throw new Error("too many redirects");
}

module.exports = { isPrivateHost, resolvesToPrivate, validateUrl, safeFetch };
