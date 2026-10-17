// Web-shell end-to-end smoke test (D0). Needs a display (xvfb is fine):
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" npx electron test/e2e/webshell.e2e.cjs [--no-sandbox]
//   E2E_OFFLINE=1 ...        same, with every off-origin request dropped
//   E2E_SHOTS=/some/dir ...  also save screenshots there
//
// Boots the real main.js with a throwaway profile, then drives the packaged site:
// desktop mode, the bridge (top frame yes, tool iframe no), Firebase, the worker,
// navigation/popup policy, the IPC sender guard, the title-bar overlay and a local
// tool. Prints one line per check and exits non-zero on any failure. Not part of
// `npm test` (that suite must run headless without Electron).

const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, shell, ipcMain, dialog } = require("electron");

const OFFLINE = process.env.E2E_OFFLINE === "1";
const SHOTS = process.env.E2E_SHOTS || "";
const ROOT = path.join(__dirname, "..", "..");
const pkg = require(path.join(ROOT, "package.json"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dn-e2e-"));
app.setPath("userData", profile);
app.getVersion = () => pkg.version; // the entry is this file, not the app's package.json

const opened = [];
shell.openExternal = async (url) => { opened.push(String(url)); }; // never launch a real browser
let leavePrompts = 0;
dialog.showMessageBoxSync = () => { leavePrompts++; return 0; }; // "Leave"
const consoleLines = [];
const results = [];
const T0 = Date.now();
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log((process.env.E2E_TIMES ? "[+" + Math.round((Date.now() - T0) / 1000) + "s] " : "") + (ok ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  -- " + String(detail).slice(0, 300) : "")); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 20000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await wait(step);
  }
}

let mainSeen = false;
app.on("browser-window-created", (_e, w) => {
  if (mainSeen || w.getParentWindow()) return; // auth popups, report windows
  mainSeen = true;
  w.webContents.on("console-message", (e) => consoleLines.push({ level: e.level, message: String(e.message), source: String(e.sourceId || "") }));
  if (OFFLINE) {
    w.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, cb) => {
      let u = null; try { u = new URL(d.url); } catch (_) {}
      const offOrigin = !!u && /^(https?|wss?):$/.test(u.protocol) && u.host !== "localhost:47913";
      cb({ cancel: offOrigin });
    });
  }
  w.webContents.once("did-finish-load", () => run(w).catch((e) => { check("driver", false, e && e.stack); finish(); }));
});

async function shot(w, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, name + ".png"), img.toPNG());
}

async function run(w) {
  const ev = (js) => w.webContents.executeJavaScript(js, true);
  const ORIGIN = "http://localhost:47913";
  w.setSize(1300, 840);

  check("loads the packaged site on the app origin", (await ev("location.origin")) === ORIGIN, await ev("location.href"));
  const signin = await until(() => ev("!!document.querySelector('.auth-page')"), 25000);
  check("desktop mode skips the landing and opens sign-in", signin && !(await ev("document.body.classList.contains('landing')")));
  check("html[data-desktop] is set", await ev("document.documentElement.getAttribute('data-desktop')") === process.platform);
  check("no service worker registered in desktop mode", (await ev("navigator.serviceWorker.getRegistrations().then(r => r.length)")) === 0);
  const desk = await ev("JSON.stringify(window.darknode && window.darknode.desktop)");
  check("bridge: window.darknode.desktop in the top frame", /"caps"/.test(desk || "") && JSON.parse(desk).version === pkg.version, desk);
  check("bridge: auth.google is a function", await ev("typeof (window.darknode && window.darknode.auth && window.darknode.auth.google) === 'function'"));
  check("bridge: does not expose the classic native surface", await ev("!('run' in window.darknode) && !('fsWrite' in window.darknode) && !('ptySpawn' in window.darknode)"));
  check("website namespace still mutable (assistant API attaches)", await until(() => ev("typeof window.darknode.control === 'function' || typeof window.darknode.openHelp === 'function'"), 15000));
  const tb = await ev("JSON.stringify((() => { const t = document.getElementById('topbar'); const cs = getComputedStyle(t); return { region: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'), pr: parseFloat(cs.paddingRight), wco: navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : null }; })())");
  const tbo = JSON.parse(tb);
  check("top bar is the drag region", tbo.region === "drag", tb);
  if (process.platform !== "darwin") check("window-controls overlay active and the bar clears it", tbo.wco === true && tbo.pr >= 100, tb);
  check("title-bar recolour IPC accepted", (await ev("window.darknode.titlebar({ color: '#ffffff', symbolColor: '#111111' })")) === (process.platform !== "darwin"));
  await shot(w, (OFFLINE ? "offline-" : "") + "signin-1300x840");

  // Firebase: the SDK the page uses is the vendored copy, and it initialised.
  const fb = await ev("import('/js/firebase.js?v=20261007a').then(m => JSON.stringify({ project: m.app.options.projectId, vendored: performance.getEntriesByType('resource').some(e => e.name.includes('/__vendor/www.gstatic.com/firebasejs/')) }))");
  check("Firebase initialises from the vendored SDK", /"project":"sentinel-b4194"/.test(fb) && /"vendored":true/.test(fb), fb);

  if (!OFFLINE) {
    const authProbe = await ev(`(async () => {
      const A = await import('/__vendor/www.gstatic.com/firebasejs/12.17.0/firebase-auth.js');
      const F = await import('/js/firebase.js?v=20261007a');
      const out = {};
      try { await A.signInWithEmailAndPassword(F.auth, 'd0-e2e-nonexistent@darknode.ai', 'not-the-password-42'); out.email = 'signed-in?'; } catch (e) { out.email = e.code || e.message; }
      try { await A.signInWithCredential(F.auth, A.GoogleAuthProvider.credential('eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.c2ln')); out.cred = 'signed-in?'; } catch (e) { out.cred = e.code || e.message; }
      return JSON.stringify(out);
    })()`);
    check("Firebase Auth email sign-in reaches the server (domain/key accepted)", /"email":"auth\/invalid-credential"/.test(authProbe), authProbe);
    check("signInWithCredential(Google) passes the domain check", /"cred":"auth\/invalid-credential"/.test(authProbe), authProbe);
    const fs1 = await ev(`(async () => { const S = await import('/__vendor/www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js'); const F = await import('/js/firebase.js?v=20261007a'); try { const s = await S.getDocs(S.query(S.collection(F.db, 'demoTools'), S.limit(1))); return 'ok:' + s.size; } catch (e) { return e.code || e.message; } })()`);
    check("Firestore read works", /^ok:/.test(fs1), fs1);
    const wk = await ev("import('/js/net.js?v=20261011a').then(m => m.dnFetch('https://example.com/')).then(r => 'status:' + r.status, e => 'error:' + e.message)");
    check("worker /api/fetch works (CORS)", wk === "status:200", wk);
  }

  // Desktop home, part 1: an account without the Deck (Test Mode is never admin) gets an
  // honest notice, not the console.
  await ev("document.getElementById('testMode').click()");
  const noted = await until(() => ev("!!document.querySelector('.dsk-note')"), 20000);
  check("non-admin session: honest notice, no console fallback", noted && !(await ev("!!document.querySelector('.app-main') || !!document.querySelector('body > .dk')")), await ev("(document.querySelector('.dsk-note h1') || {}).textContent || ''"));
  check("notice page has a window drag strip", (await ev("(() => { const cs = getComputedStyle(document.querySelector('.dsk-drag')); return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'); })()")) === "drag");
  await wait(1200); // boot screen fade
  await shot(w, (OFFLINE ? "offline-" : "") + "notice-1300x840");

  // Desktop home, part 2: the Deck as the home screen. auth.js mounts it only for the
  // admin claim, which this harness cannot hold, so the harness calls the same
  // admin.js openDeck(user, { onSignOut }) that auth.js calls for an admin.
  await ev("window.__tb = []; (() => { const t = window.darknode.titlebar; window.darknode.titlebar = (o) => { window.__tb.push(o); return t(o); }; })()");
  await ev("document.getElementById('view').innerHTML = ''; import('/js/admin.js?v=20261017d').then(m => m.openDeck({ uid: 'e2e-harness', email: 'test@darknode.ai', displayName: 'Harness' }, { onSignOut: () => { window.__signedOut = true; } })).then(() => 'ok', e => 'error:' + e.message)");
  const deck = await until(() => ev("!!document.querySelector('body > .dk .dk-top')"), 20000);
  check("Deck mounts as the app home screen", deck);
  await wait(1500);
  check("no console behind the Deck", await ev("!document.querySelector('.app-main, .aws-side') && document.getElementById('view').children.length === 0"));
  await ev("document.getElementById('dkAcct').click()"); await wait(300);
  const menu = await ev("JSON.stringify({ console: !!document.getElementById('dkMiConsole'), exit: (document.getElementById('dkMiExit') || {}).textContent || '' })");
  check("no 'back to console' exit; account menu signs out", menu === JSON.stringify({ console: false, exit: "Sign out" }), menu);
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await wait(300);
  check("Escape does not leave the Deck", await ev("!!document.querySelector('body > .dk')"));
  const dk = await ev("JSON.stringify((() => { const t = document.querySelector('.dk .dk-top'); const cs = getComputedStyle(t); const r = navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect() : null; const acct = document.getElementById('dkAcct').getBoundingClientRect(); const srch = document.getElementById('dkHSearch'); return { region: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'), btn: getComputedStyle(srch).getPropertyValue('-webkit-app-region') || getComputedStyle(srch).getPropertyValue('app-region'), free: r ? Math.round(r.right) : null, acct: Math.round(acct.right) }; })())");
  const dko = JSON.parse(dk);
  check("Deck header is the drag region; its buttons stay clickable", dko.region === "drag" && dko.btn === "no-drag", dk);
  if (process.platform !== "darwin") check("Deck header controls end before the window buttons", dko.free !== null && dko.acct <= dko.free, dk);
  const tbl = await ev("JSON.stringify(window.__tb[window.__tb.length - 1] || null)");
  check("window buttons recoloured to the Deck header", /"height":5[56]/.test(tbl || "") && /"color":"#[0-3][0-9a-f][0-3][0-9a-f][0-3][0-9a-f]"/.test(tbl || ""), tbl);
  await shot(w, (OFFLINE ? "offline-" : "") + "deck-1300x840");
  if (SHOTS && process.env.E2E_XWD === "1") { try { require("child_process").execFileSync("xwd", ["-root", "-display", process.env.DISPLAY, "-out", path.join(SHOTS, (OFFLINE ? "offline-" : "") + "screen.xwd")]); } catch (e) { console.log("xwd failed: " + e.message); } }

  // Navigation + popup policy.
  opened.length = 0;
  await ev("location.href = 'https://example.com/nav-test'");
  await wait(1200);
  check("off-origin navigation blocked and sent to the OS browser", (await ev("location.origin")) === ORIGIN && opened.includes("https://example.com/nav-test"), opened.join(","));
  opened.length = 0;
  await ev("window.open('https://example.org/popup-test'); window.open('file:///etc/passwd'); window.open('data:text/html,x'); window.open('/hashsuite')");
  await wait(800);
  check("window.open: http(s) external only, other schemes and app paths dropped", opened.length === 1 && opened[0] === "https://example.org/popup-test", opened.join(","));
  // Printable reports: window.open("") gives a blank child window the page fills; it
  // must not get the bridge.
  await ev("window.__pr = 'start'; setTimeout(() => { try { const c = window.open('', '_blank'); window.__pr = 'opened:' + !!c; if (!c) return; c.document.write('<p id=r>report</p>'); window.__pr = JSON.stringify({ text: c.document.getElementById('r').textContent, bridge: !!(c.darknode && c.darknode.desktop) }); c.close(); } catch (e) { window.__pr = 'error:' + e.message; } }, 0); 1");
  await until(() => ev("window.__pr && window.__pr[0] === '{'"), 5000);
  const pr = await ev("window.__pr");
  check("report window opens without the bridge", pr === JSON.stringify({ text: "report", bridge: false }), pr);

  // A client-side tool runs inside the Deck's tool workspace (offline too).
  await ev("(() => { const c = document.querySelector('.dk .dk-gcard[data-sec=\"hashsuite\"]'); if (c) c.click(); })()");
  let inDeck = await until(() => ev("!!document.querySelector('.dk iframe[src*=\"/hashsuite\"]')"), 3000);
  if (!inDeck) {
    await ev("document.getElementById('dkHSearch').click()"); await wait(400);
    await ev("(() => { const i = document.querySelector('.dk-spot input'); i.value = 'Hash Suite'; i.dispatchEvent(new Event('input', { bubbles: true })); })()"); await wait(500);
    await ev("(() => { const i = document.querySelector('.dk-spot input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    inDeck = await until(() => ev("!!document.querySelector('.dk iframe[src*=\"/hashsuite\"]')"), 8000);
  }
  let digest = "";
  if (inDeck) {
    const fdoc = "document.querySelector('.dk iframe[src*=\"/hashsuite\"]').contentDocument";
    const hs = await until(() => ev(`!!(${fdoc} && ${fdoc}.getElementById('compute-btn'))`), 25000);
    if (hs) {
      await ev(`(() => { const d = ${fdoc}; const i = d.getElementById('compute-input'); i.value = 'abc'; i.dispatchEvent(new Event('input', { bubbles: true })); const a = d.getElementById('compute-algo'); const o = Array.from(a.options).find(o => /sha-?256/i.test(o.value + o.textContent)); if (o) { a.value = o.value; a.dispatchEvent(new Event('change', { bubbles: true })); } d.getElementById('compute-btn').click(); })()`);
      digest = await until(() => ev(`((${fdoc}.getElementById('compute-output') || {}).textContent || '')`).then((t) => /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/i.test(t) && t), 10000);
    }
  }
  check("local tool (Hash Suite SHA-256) runs inside the Deck", !!digest, inDeck ? "frame ok" : "frame not opened");
  await wait(600);
  await shot(w, (OFFLINE ? "offline-" : "") + "deck-tool-hashsuite-1300x840");

  // Tool iframe (?embed=1): same origin, but no bridge and not in desktop mode.
  const fr = await ev(`new Promise((res) => { const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;opacity:0'; f.src = '/hashsuite?embed=1'; f.onload = () => setTimeout(() => { const cw = f.contentWindow; res(JSON.stringify({ desktop: !!(cw.darknode && cw.darknode.desktop), auth: !!(cw.darknode && cw.darknode.auth), attr: cw.document.documentElement.hasAttribute('data-desktop') })); f.remove(); }, 2500); document.body.appendChild(f); })`);
  check("tool iframe gets no bridge and no desktop mode", fr === JSON.stringify({ desktop: false, auth: false, attr: false }), fr);

  // When a page guards unload (the site does after typing in a tool); an off-origin link must still
  // reach the OS browser (via the leave prompt) and the page must stay.
  opened.length = 0;
  await ev("window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); document.body.click()");
  await ev("location.href = 'https://example.com/after-typing'");
  await wait(1200);
  check("unload guard: leave prompt shown, link opened externally, page kept", leavePrompts === 1 && opened.includes("https://example.com/after-typing") && (await ev("location.origin")) === ORIGIN, "prompts=" + leavePrompts + " opened=" + opened.join(","));

  // IPC sender guard, exercised through the real wrapped handlers.
  const handlers = ipcMain._invokeHandlers;
  if (handlers && handlers.get) {
    const h = handlers.get("openExternal");
    const call = async (frame, ch = "openExternal") => { try { await handlers.get(ch)({ senderFrame: frame }, "https://example.net/"); return "allowed"; } catch (e) { return "refused"; } };
    check("IPC refused from another origin", (await call({ url: "https://evil.example/", parent: null })) === "refused");
    check("IPC refused from an app-origin sub-frame", (await call({ url: ORIGIN + "/hashsuite?embed=1", parent: {} })) === "refused");
    check("IPC refused with no sender frame", (await call(null)) === "refused");
    check("IPC refused for a classic-only channel from the app origin", (await call({ url: ORIGIN + "/", parent: null }, "run")) === "refused");
    check("IPC allowed from the app top frame", !!h && (await call({ url: ORIGIN + "/", parent: null })) === "allowed");
  } else check("IPC guard probe (internal handler map unavailable)", false);

  // Window controls (native overlay on win/linux; the APIs it drives).
  w.maximize(); await wait(400); const maxed = w.isMaximized(); w.unmaximize(); await wait(300);
  // Xvfb has no window manager, so maximise is a no-op there; report, don't fail.
  if (maxed || process.env.E2E_REQUIRE_WM === "1") check("window maximise/restore", maxed && !w.isMaximized());
  else console.log("SKIP window maximise/restore (no window manager on this display)");

  // Small window.
  w.setSize(900, 600); await wait(1200);
  await shot(w, (OFFLINE ? "offline-" : "") + "deck-900x600");

  const csp = consoleLines.filter((l) => /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(l.message));
  check("no CSP violations in the console", OFFLINE || csp.length === 0, csp.map((l) => l.message).join(" | "));
  const errs = consoleLines.filter((l) => l.level === "error");
  console.log("console errors (" + errs.length + "):");
  for (const l of errs.slice(0, 25)) console.log("  - " + l.message.slice(0, 220).replace(/\s+/g, " ") + (l.source ? "  @ " + l.source.slice(0, 90) : ""));
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed${OFFLINE ? " (offline)" : ""}`);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed ? 1 : 0);
}

setTimeout(() => { check("finished within 240 s", false); finish(); }, Number(process.env.E2E_TIMEOUT_MS) || 240000).unref();
require(path.join(ROOT, "main.js"));
