// Desktop Google sign-in (D0): loopback + PKCE in the system browser, ID token
// only. Google is faked: openExternal plays the browser and hits the loopback
// redirect; fetchImpl plays the token endpoint. No network.
import { test, group, assert } from "../harness.mjs";
import http from "node:http";
import crypto from "node:crypto";
import G from "../../lib/webshell/google-signin.js";

const CLIENT = "123-abc.apps.googleusercontent.com";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => b64({ alg: "RS256" }) + "." + b64(p) + ".sig";

// Simulated browser: parse the auth URL, then call the loopback redirect.
function browser({ deny = false, wrongState = false } = {}) {
  const seen = {};
  const openExternal = async (url) => {
    const u = new URL(url);
    Object.assign(seen, Object.fromEntries(u.searchParams));
    const redirect = new URL(seen.redirect_uri);
    redirect.searchParams.set("state", wrongState ? "forged" : seen.state);
    if (deny) redirect.searchParams.set("error", "access_denied"); else redirect.searchParams.set("code", "auth-code-1");
    setTimeout(() => http.get(redirect.href, (res) => res.resume()).on("error", () => {}), 5);
  };
  return { seen, openExternal };
}
function tokenEndpoint(seen, makeToken) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, body });
    return { json: async () => ({ id_token: makeToken(seen, body), access_token: "ACCESS-SHOULD-NOT-LEAK" }) };
  };
  return { calls, fetchImpl };
}
const good = (seen) => jwt({ iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, nonce: seen.nonce, email: "test@darknode.ai" });

group("webshell.google-signin: pieces", () => {
  test("auth URL asks for openid/email/profile with S256 PKCE and loopback redirect", () => {
    const u = new URL(G.authUrl({ clientId: CLIENT, redirectUri: "http://127.0.0.1:5555", state: "s", challenge: "c", nonce: "n" }));
    assert.equal(u.searchParams.get("scope"), "openid email profile");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:5555");
  });
  test("PKCE challenge is SHA-256 of the verifier", () => {
    const { verifier, challenge } = G.pkcePair();
    assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
  });
  test("callback parsing enforces state", () => {
    assert.equal(G.parseCallback("/?code=x&state=s", "s").kind, "code");
    assert.equal(G.parseCallback("/?code=x&state=t", "s").kind, "bad-state");
    assert.equal(G.parseCallback("/favicon.ico", "s").kind, "ignore");
    assert.equal(G.parseCallback("/?error=access_denied&state=s", "s").kind, "error");
  });
  test("ID token checks: issuer, audience, expiry, nonce", () => {
    const now = Date.now(), exp = Math.floor(now / 1000) + 60;
    assert.equal(G.checkIdToken(jwt({ iss: "https://accounts.google.com", aud: CLIENT, exp, nonce: "n" }), { clientId: CLIENT, nonce: "n", now }), null);
    assert.ok(G.checkIdToken(jwt({ iss: "https://evil.example", aud: CLIENT, exp }), { clientId: CLIENT, now }));
    assert.ok(G.checkIdToken(jwt({ iss: "accounts.google.com", aud: "other", exp }), { clientId: CLIENT, now }));
    assert.ok(G.checkIdToken(jwt({ iss: "accounts.google.com", aud: CLIENT, exp: 1 }), { clientId: CLIENT, now }));
    assert.ok(G.checkIdToken(jwt({ iss: "accounts.google.com", aud: CLIENT, exp, nonce: "x" }), { clientId: CLIENT, nonce: "n", now }));
    assert.ok(G.checkIdToken("garbage", { clientId: CLIENT, now }));
  });
});

group("webshell.google-signin: full loopback flow (faked Google)", () => {
  test("returns only the ID token; exchanges the code with the PKCE verifier", async () => {
    const b = browser();
    const t = tokenEndpoint(b.seen, good);
    const r = await G.runGoogleSignIn({ http, openExternal: b.openExternal, fetchImpl: t.fetchImpl, clientId: CLIENT, clientSecret: "sec", timeoutMs: 5000 });
    assert.ok(r.ok, r.error);
    assert.deepEqual(Object.keys(r).sort(), ["idToken", "ok"]);
    assert.equal(t.calls[0].url, "https://oauth2.googleapis.com/token");
    assert.equal(t.calls[0].body.code, "auth-code-1");
    assert.equal(crypto.createHash("sha256").update(t.calls[0].body.code_verifier).digest("base64url"), b.seen.code_challenge);
    assert.equal(t.calls[0].body.redirect_uri, b.seen.redirect_uri);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(b.seen.redirect_uri));
  });
  test("a forged state is rejected and never exchanged", async () => {
    const b = browser({ wrongState: true });
    const t = tokenEndpoint(b.seen, good);
    const r = await G.runGoogleSignIn({ http, openExternal: b.openExternal, fetchImpl: t.fetchImpl, clientId: CLIENT, timeoutMs: 600 });
    assert.notOk(r.ok);
    assert.equal(t.calls.length, 0);
  });
  test("user cancel is reported", async () => {
    const b = browser({ deny: true });
    const r = await G.runGoogleSignIn({ http, openExternal: b.openExternal, fetchImpl: async () => { throw new Error("no"); }, clientId: CLIENT, timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Sign-in was cancelled.");
  });
  test("a token for another client is refused", async () => {
    const b = browser();
    const t = tokenEndpoint(b.seen, (seen) => jwt({ iss: "https://accounts.google.com", aud: "someone-else", exp: Math.floor(Date.now() / 1000) + 600, nonce: seen.nonce }));
    const r = await G.runGoogleSignIn({ http, openExternal: b.openExternal, fetchImpl: t.fetchImpl, clientId: CLIENT, timeoutMs: 5000 });
    assert.notOk(r.ok);
    assert.ok(/audience/.test(r.error));
  });
  test("unconfigured client fails clearly without opening a browser", async () => {
    let opened = false;
    const r = await G.runGoogleSignIn({ http, openExternal: () => { opened = true; }, fetchImpl: async () => ({}), clientId: "" });
    assert.notOk(r.ok); assert.notOk(opened);
  });
});
