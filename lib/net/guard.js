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
  if (h === "::" || h === "::1") return true;
  // IPv6 unique-local (fc00::/7) + link-local (fe80::/10). Gate on a colon so a
  // real IPv6 LITERAL is matched but a public DNS name like "fcc.gov" / "fdroid.org"
  // / "fe80host.com" is NOT wrongly treated as private.
  if (h.includes(":") && (h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h))) return true;
  const mapped = h.match(/^::ffff:(.+)$/i);            // IPv4-mapped IPv6 -> check the v4 tail
  if (mapped) {
    let tail = mapped[1];
    const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); // hex form (::ffff:7f00:1 == 127.0.0.1)
    if (hx) { const n = ((parseInt(hx[1], 16) << 16) >>> 0) + parseInt(hx[2], 16); tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); }
    return isPrivateHost(tail);
  }
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
// Case-insensitively drop the named headers from a plain headers object.
function dropHeaders(headers, names) {
  const drop = new Set(names); const out = {};
  for (const k of Object.keys(headers || {})) if (!drop.has(k.toLowerCase())) out[k] = headers[k];
  return out;
}

async function safeFetch(url, opts = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const maxHops = deps.maxHops == null ? 5 : deps.maxHops;
  let current = String(url);
  let method = (opts.method || "GET").toUpperCase();
  let body = opts.body;
  let headers = Object.assign({}, opts.headers);
  for (let hop = 0; hop <= maxHops; hop++) {
    const bad = await validateUrl(current, deps);
    if (bad) throw new Error(bad);
    const r = await fetchImpl(current, Object.assign({}, opts, { method, body, headers, redirect: "manual" }));
    const loc = r.status >= 300 && r.status < 400 && r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
    if (!loc) return r;
    const next = new URL(loc, current), prevOrigin = new URL(current).origin;
    // 301/302/303 → the follow-up is a bodyless GET (RFC 9110 §15.4); 307/308 keep method+body.
    if (r.status === 301 || r.status === 302 || r.status === 303) { method = "GET"; body = undefined; }
    // Crossing origin → drop the credentials the caller scoped to the original host
    // (browsers strip Authorization on a cross-origin redirect; this client must too).
    if (next.origin !== prevOrigin) headers = dropHeaders(headers, ["authorization", "cookie"]);
    if (body === undefined) headers = dropHeaders(headers, ["content-length", "content-type"]);
    current = next.toString();
  }
  throw new Error("too many redirects");
}

module.exports = { isPrivateHost, resolvesToPrivate, validateUrl, safeFetch, dropHeaders };
