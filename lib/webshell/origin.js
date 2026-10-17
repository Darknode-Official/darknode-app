// Web-shell origin policy (main process + preload) - D0.
//
// The packaged website is served from a fixed loopback ORIGIN that never touches
// a socket: the app's own session intercepts http://localhost:47913/* and answers
// from the bundled web/ directory (see lib/webshell/serve.js). `localhost` was
// chosen over a custom scheme because the website's licence locks, the Firebase
// Auth authorized-domain list and the Cloudflare worker's CORS allow-list all
// accept localhost and reject anything else (spiked: app://darknode got a 403
// "Origin not allowed" from the worker). The origin must stay stable: Firebase's
// IndexedDB session, localStorage and every tool's saved state are per-origin.
//
// Everything here is pure so test/webshell/origin.test.mjs can pin the policy.

const APP_HOST = "localhost:47913";
const APP_ORIGIN = "http://" + APP_HOST;

// Firebase Auth popup handler hosts. For a localhost page firebase.js picks
// authDomain sentinel-b4194.firebaseapp.com; darknode.ai is listed so the policy
// still holds if that ever changes.
const AUTH_POPUP_HOSTS = ["sentinel-b4194.firebaseapp.com", "darknode.ai"];
// Hosts an auth popup may move through after it opens (provider sign-in pages).
const AUTH_FLOW_HOSTS = AUTH_POPUP_HOSTS.concat(["github.com", "accounts.google.com"]);

function parse(url) { try { return new URL(String(url)); } catch (_) { return null; } }

// True only for a URL on the exact app origin (scheme + host + port).
function isAppUrl(url, appOrigin = APP_ORIGIN) {
  const u = parse(url);
  return !!u && u.origin === appOrigin;
}

// The classic renderer is a single local file; accept it with any query/hash.
function isClassicUrl(url, classicFileUrl) {
  const u = parse(url);
  if (!u || u.protocol !== "file:" || !classicFileUrl) return false;
  const c = parse(classicFileUrl);
  return !!c && u.pathname === c.pathname;
}

// Who may call an IPC channel. `frame` is { url, isTop } describing
// event.senderFrame; a missing/destroyed frame or a sub-frame is always refused.
// In web-shell mode only the top-level app-origin frame is trusted; in classic
// mode only the top-level classic renderer file is.
function isTrustedSender(frame, ctx) {
  if (!frame || !frame.isTop || typeof frame.url !== "string") return false;
  if (ctx.mode === "web") return isAppUrl(frame.url, ctx.appOrigin || APP_ORIGIN);
  if (ctx.mode === "classic") return isClassicUrl(frame.url, ctx.classicFileUrl);
  return false;
}

// Channels the web shell may call. The website can host untrusted content (tools
// render third-party data, the page allows inline script), so it does NOT get the
// classic renderer's shell/fs/pty/vm surface in D0; each native capability is
// added to this list deliberately in later phases.
const WEB_CHANNELS = new Set(["auth:google", "openExternal", "shell:titlebar"]);

function channelAllowed(channel, ctx) {
  if (ctx.mode === "web") return WEB_CHANNELS.has(channel);
  return ctx.mode === "classic";
}

// Main-window navigation: stay on the app origin; http(s) elsewhere goes to the
// OS browser; every other scheme is dropped.
function classifyNavigation(url, appOrigin = APP_ORIGIN) {
  const u = parse(url);
  if (!u) return "deny";
  if (u.origin === appOrigin) return "allow";
  if (u.protocol === "http:" || u.protocol === "https:") return "external";
  return "deny";
}

// window.open from the app: only the Firebase auth handler may open in-app (as a
// sandboxed, preload-free popup); other http(s) URLs open in the OS browser.
function classifyWindowOpen(url, appOrigin = APP_ORIGIN) {
  const u = parse(url);
  if (!u) return "deny";
  if (u.protocol === "https:" && AUTH_POPUP_HOSTS.includes(u.hostname) && u.pathname.startsWith("/__/auth/")) return "auth-popup";
  // window.open("") from the page itself: a blank, same-origin document the page fills
  // (the Deck's printable reports). Opens as a plain child window: no bridge, no navigation.
  if (u.href === "about:blank") return "blank";
  if (u.origin === appOrigin) return "deny";
  if (u.protocol === "http:" || u.protocol === "https:") return "external";
  return "deny";
}

// Navigation inside an auth popup: https on the auth/provider hosts only.
function authPopupNavAllowed(url) {
  const u = parse(url);
  return !!u && u.protocol === "https:" && AUTH_FLOW_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
}

module.exports = {
  APP_HOST, APP_ORIGIN, AUTH_POPUP_HOSTS, AUTH_FLOW_HOSTS, WEB_CHANNELS,
  isAppUrl, isClassicUrl, isTrustedSender, channelAllowed,
  classifyNavigation, classifyWindowOpen, authPopupNavAllowed,
};
