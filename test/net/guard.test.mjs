// SSRF guard tests (DA-007) — literal-bypass escape suite + redirect re-validation.
// Pure/deterministic: DNS and fetch are injected, nothing hits the network.
import { test, group, assert } from "../harness.mjs";
import G from "../../lib/net/guard.js";

const { isPrivateHost, validateUrl, safeFetch } = G;

group("net.guard: isPrivateHost blocks private/internal literals", () => {
  const BLOCK = [
    "127.0.0.1", "0.0.0.0", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.169.254",            // AWS/GCP/Azure metadata
    "100.64.0.1",                 // CGNAT
    "localhost", "foo.localhost",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",   // IPv4-mapped IPv6
    "2130706433",                 // decimal for 127.0.0.1 (bare int -> deny)
    "0x7f000001",                 // hex literal -> deny
    "999.1.1.1",                  // malformed octet -> deny
    "",                           // empty -> deny (fail closed)
  ];
  for (const h of BLOCK) test(`blocks ${JSON.stringify(h)}`, () => assert.ok(isPrivateHost(h), `${h} should be blocked`));
});

group("net.guard: isPrivateHost allows public hosts", () => {
  const ALLOW = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "example.com", "api.github.com", "172.32.0.1", "11.0.0.1"];
  for (const h of ALLOW) test(`allows ${h}`, () => assert.notOk(isPrivateHost(h), `${h} should be allowed`));
});

group("net.guard: validateUrl", () => {
  const pub = async () => false, priv = async () => true;
  test("rejects non-http(s) schemes", async () => {
    assert.equal(await validateUrl("file:///etc/passwd", { resolvesToPrivate: pub }), "bad url");
    assert.equal(await validateUrl("gopher://x/", { resolvesToPrivate: pub }), "bad url");
  });
  test("blocks a public NAME that resolves to a private IP (DNS rebind)", async () => {
    const r = await validateUrl("http://evil.example.com/", { resolvesToPrivate: priv });
    assert.ok(/blocked host/.test(r), `expected blocked, got ${r}`);
  });
  test("allows a public host that resolves public", async () => {
    assert.equal(await validateUrl("https://example.com/", { resolvesToPrivate: pub }), null);
  });
});

// Minimal fake Response for safeFetch.
function resp(status, location) {
  return { status, headers: { get: (k) => (k.toLowerCase() === "location" && location ? location : null) } };
}

group("net.guard: safeFetch re-validates every redirect hop", () => {
  const pub = async () => false;

  test("blocks a redirect from a public host to a private host", async () => {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url === "https://public.example.com/") return resp(302, "http://169.254.169.254/latest/meta-data/");
      return resp(200);
    };
    let err = null;
    try { await safeFetch("https://public.example.com/", {}, { fetch: fakeFetch, resolvesToPrivate: pub }); }
    catch (e) { err = e.message; }
    assert.ok(err && /blocked host/.test(err), `redirect to metadata must be blocked, got ${err}`);
    assert.deepEqual(calls, ["https://public.example.com/"], "must not fetch the private redirect target");
  });

  test("follows a redirect between two public hosts", async () => {
    const fakeFetch = async (url) => {
      if (url === "https://a.example.com/") return resp(301, "https://b.example.com/final");
      if (url === "https://b.example.com/final") return resp(200);
      throw new Error("unexpected " + url);
    };
    const r = await safeFetch("https://a.example.com/", {}, { fetch: fakeFetch, resolvesToPrivate: pub });
    assert.equal(r.status, 200);
  });

  test("blocks the initial host before any fetch", async () => {
    let fetched = false;
    const fakeFetch = async () => { fetched = true; return resp(200); };
    let err = null;
    try { await safeFetch("http://127.0.0.1/", {}, { fetch: fakeFetch, resolvesToPrivate: pub }); }
    catch (e) { err = e.message; }
    assert.ok(err && /blocked host/.test(err));
    assert.notOk(fetched, "must not fetch a blocked initial host");
  });

  test("gives up after too many redirects", async () => {
    const fakeFetch = async () => resp(302, "https://loop.example.com/");
    let err = null;
    try { await safeFetch("https://loop.example.com/", {}, { fetch: fakeFetch, resolvesToPrivate: pub, maxHops: 3 }); }
    catch (e) { err = e.message; }
    assert.ok(err && /too many redirects/.test(err), `got ${err}`);
  });
});
