// Google sign-in for the web shell (main process) - D0.
//
// Google refuses OAuth inside embedded browsers, so the website's "Continue with
// Google" button asks the app instead: the system browser runs the standard
// installed-app flow (loopback redirect + PKCE, RFC 8252) and the app hands the
// page ONLY the resulting Google ID token, which the page exchanges with
// signInWithCredential(GoogleAuthProvider.credential(idToken)). No access or
// refresh token is requested for sign-in (scopes are openid/email/profile), and
// nothing here logs or persists a token.
//
// The OAuth client must be a "Desktop app" client in the same Google Cloud
// project as Firebase (sentinel-b4194 / 153127828172) so Firebase Auth accepts
// the token's audience. It is read from env or the gitignored oauth.config.json,
// never from source.

const crypto = require("crypto");

const SCOPES = ["openid", "email", "profile"];
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function authUrl({ clientId, redirectUri, state, challenge, nonce }) {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: SCOPES.join(" "), state, nonce,
    code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
}

// Decode (NOT verify) a JWT payload. Firebase verifies the signature server-side;
// these checks only stop the app from forwarding an obviously wrong token.
function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); }
  catch (_) { return null; }
}

function checkIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  const p = decodeJwtPayload(idToken);
  if (!p) return "malformed ID token";
  if (!ISSUERS.has(p.iss)) return "unexpected token issuer";
  if (p.aud !== clientId) return "token audience does not match this app";
  if (typeof p.exp !== "number" || p.exp * 1000 < now) return "token expired";
  if (nonce && p.nonce !== nonce) return "token nonce mismatch";
  return null;
}

// Classify a loopback callback request. Only "/" with our exact state counts.
function parseCallback(reqUrl, expectedState) {
  let u; try { u = new URL(reqUrl, "http://127.0.0.1"); } catch (_) { return { kind: "ignore" }; }
  if (u.pathname !== "/") return { kind: "ignore" };
  const code = u.searchParams.get("code"), err = u.searchParams.get("error");
  if (!code && !err) return { kind: "ignore" };
  if (u.searchParams.get("state") !== expectedState) return { kind: "bad-state" };
  if (err) return { kind: "error", error: err };
  return { kind: "code", code };
}

const PAGE = (ok) => "<!doctype html><meta charset=utf-8><title>Darknode</title><body style='font-family:system-ui,sans-serif;background:#0b0e14;color:#e6edf3;text-align:center;padding-top:90px'><h2>" +
  (ok ? "Signed in to Darknode" : "Sign-in did not complete") + "</h2><p>You can close this tab and return to the Darknode app.</p>";

// Run the flow. deps: { http, openExternal, fetchImpl, clientId, clientSecret, timeoutMs }
// Resolves { ok:true, idToken } or { ok:false, error }.
function runGoogleSignIn(deps) {
  const { http, openExternal, fetchImpl, clientId, clientSecret } = deps;
  const timeoutMs = deps.timeoutMs || 300000;
  if (!clientId) return Promise.resolve({ ok: false, error: "Google sign-in is not configured for this build (no desktop OAuth client id)." });
  return new Promise((resolve) => {
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    let redirectUri = "", done = false, timer = null;
    const server = http.createServer(async (req, res) => {
      const cb = parseCallback(req.url, state);
      if (cb.kind === "ignore") { res.writeHead(404); res.end(); return; }
      if (cb.kind === "bad-state") { res.writeHead(400); res.end("bad state"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (cb.kind === "error") { res.end(PAGE(false)); return finish({ ok: false, error: cb.error === "access_denied" ? "Sign-in was cancelled." : "Google returned: " + cb.error }); }
      try {
        const body = { client_id: clientId, code: cb.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri };
        if (clientSecret) body.client_secret = clientSecret;
        const r = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
        const d = await r.json();
        const idToken = d && d.id_token;
        const problem = idToken ? checkIdToken(idToken, { clientId, nonce }) : ((d && (d.error_description || d.error)) || "no ID token returned");
        res.end(PAGE(!problem));
        finish(problem ? { ok: false, error: problem } : { ok: true, idToken });
      } catch (e) { res.end(PAGE(false)); finish({ ok: false, error: "token exchange failed: " + ((e && e.message) || e) }); }
    });
    function finish(v) {
      if (done) return; done = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      resolve(v);
    }
    server.on("error", (e) => finish({ ok: false, error: e.message }));
    server.listen(0, "127.0.0.1", () => {
      redirectUri = "http://127.0.0.1:" + server.address().port;
      Promise.resolve(openExternal(authUrl({ clientId, redirectUri, state, challenge, nonce })))
        .catch((e) => finish({ ok: false, error: "could not open the browser: " + ((e && e.message) || e) }));
    });
    timer = setTimeout(() => finish({ ok: false, error: "Timed out waiting for Google sign-in." }), timeoutMs);
    deps.onCancel && deps.onCancel(() => finish({ ok: false, error: "Sign-in was cancelled." }));
  });
}

module.exports = { SCOPES, pkcePair, authUrl, decodeJwtPayload, checkIdToken, parseCallback, runGoogleSignIn };
