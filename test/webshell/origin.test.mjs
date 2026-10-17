// Web-shell origin gating (D0): which frames may call IPC, which channels the
// web shell may use, navigation/popup policy, and the REAL preload.js exposing
// the bridge only to the top-level app-origin frame.
import { test, group, assert } from "../harness.mjs";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import O from "../../lib/webshell/origin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = O.APP_ORIGIN;
const WEB = { mode: "web", appOrigin: APP };
const CLASSIC = { mode: "classic", classicFileUrl: "file:///opt/Darknode/resources/app.asar/renderer/index.html" };

group("webshell.origin: IPC sender gating", () => {
  test("app origin is http://localhost:47913", () => assert.equal(APP, "http://localhost:47913"));
  test("top-level app frame is trusted", () => assert.ok(O.isTrustedSender({ url: APP + "/console?x=1#y", isTop: true }, WEB)));
  test("app-origin sub-frame (tool iframe) is refused", () => assert.notOk(O.isTrustedSender({ url: APP + "/hashsuite?embed=1", isTop: false }, WEB)));
  const OTHERS = ["https://darknode.ai/", "http://localhost:47914/", "https://localhost:47913/", "http://127.0.0.1:47913/", "http://localhost/", "http://localhost:47913.evil.com/", "file:///opt/Darknode/resources/app.asar/renderer/index.html", "about:blank", "data:text/html,x", "javascript:1", "", "not a url"];
  for (const u of OTHERS) test(`refuses top frame at ${JSON.stringify(u)}`, () => assert.notOk(O.isTrustedSender({ url: u, isTop: true }, WEB)));
  test("missing frame is refused", () => { assert.notOk(O.isTrustedSender(null, WEB)); assert.notOk(O.isTrustedSender({ isTop: true }, WEB)); });
  test("classic: only its own top-level file", () => {
    assert.ok(O.isTrustedSender({ url: CLASSIC.classicFileUrl + "#tools", isTop: true }, CLASSIC));
    assert.notOk(O.isTrustedSender({ url: "file:///tmp/evil.html", isTop: true }, CLASSIC));
    assert.notOk(O.isTrustedSender({ url: APP + "/", isTop: true }, CLASSIC));
    assert.notOk(O.isTrustedSender({ url: CLASSIC.classicFileUrl, isTop: false }, CLASSIC));
  });
  test("unknown mode trusts nobody", () => assert.notOk(O.isTrustedSender({ url: APP + "/", isTop: true }, { mode: "x" })));
});

group("webshell.origin: channel allow-list", () => {
  test("web shell gets only the D0 surface", () => {
    for (const c of ["auth:google", "openExternal", "shell:titlebar"]) assert.ok(O.channelAllowed(c, WEB), c);
    for (const c of ["run", "agent:exec", "pty:spawn", "fs:write", "fs:read", "vm:start", "secret:get", "git:push", "net:get", "gmail:oauth"]) assert.notOk(O.channelAllowed(c, WEB), c);
  });
  test("classic keeps its full bridge", () => assert.ok(O.channelAllowed("run", CLASSIC)));
});

group("webshell.origin: navigation and popups", () => {
  test("same-origin navigation stays in the app", () => assert.equal(O.classifyNavigation(APP + "/navarch"), "allow"));
  test("http(s) elsewhere goes to the OS browser", () => { assert.equal(O.classifyNavigation("https://example.com/"), "external"); assert.equal(O.classifyNavigation("http://localhost:47914/"), "external"); });
  test("other schemes are dropped", () => { for (const u of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "darknode://x", "about:blank"]) assert.equal(O.classifyNavigation(u), "deny", u); });
  test("only the Firebase auth handler may pop up in-app", () => {
    assert.equal(O.classifyWindowOpen("https://sentinel-b4194.firebaseapp.com/__/auth/handler?apiKey=x"), "auth-popup");
    assert.equal(O.classifyWindowOpen("https://sentinel-b4194.firebaseapp.com/other"), "external");
    assert.equal(O.classifyWindowOpen("http://sentinel-b4194.firebaseapp.com/__/auth/handler"), "external");
    assert.equal(O.classifyWindowOpen("https://evil.firebaseapp.com/__/auth/handler"), "external");
    assert.equal(O.classifyWindowOpen(APP + "/x"), "deny");
    assert.equal(O.classifyWindowOpen("file:///etc/passwd"), "deny");
    assert.equal(O.classifyWindowOpen("about:blank"), "blank");
    assert.equal(O.classifyWindowOpen("about:blank#x"), "deny");
  });
  test("auth popup may only move between auth/provider hosts over https", () => {
    assert.ok(O.authPopupNavAllowed("https://github.com/login/oauth/authorize?x"));
    assert.ok(O.authPopupNavAllowed("https://sentinel-b4194.firebaseapp.com/__/auth/handler"));
    assert.notOk(O.authPopupNavAllowed("http://github.com/"));
    assert.notOk(O.authPopupNavAllowed("https://evilgithub.com/"));
    assert.notOk(O.authPopupNavAllowed("https://example.com/"));
  });
});

// Run the real preload.js in a sandbox with a fake electron module.
function runPreload({ argv, origin, protocol, top = true, href = origin + "/" }) {
  const calls = { exposed: [], executed: [] };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (k, api) => calls.exposed.push({ k, api }),
      executeInMainWorld: (s) => calls.executed.push(s),
    },
    ipcRenderer: { invoke: (...a) => Promise.resolve(a), on: () => {} },
  };
  const win = {};
  win.top = top ? win : {};
  const ctx = {
    require: (m) => { if (m === "electron") return electron; throw new Error("unexpected require " + m); },
    process: { argv: ["electron", ...argv], platform: "linux", arch: "x64", env: {} },
    window: win, location: { origin, protocol, href },
  };
  vm.runInNewContext(fs.readFileSync(path.join(here, "..", "..", "preload.js"), "utf8"), ctx);
  return calls;
}
const WEB_ARGS = ["--dn-shell=web", "--dn-app-origin=" + APP, "--dn-app-version=9.9.9", "--dn-caps=auth.google,openExternal"];

group("preload.js: bridge exposure is origin-gated", () => {
  test("top-level app-origin frame gets the desktop surface", () => {
    const c = runPreload({ argv: WEB_ARGS, origin: APP, protocol: "http:" });
    assert.equal(c.exposed.length, 0, "web shell must not expose the frozen classic bridge");
    assert.equal(c.executed.length, 1);
    const api = c.executed[0].args[0];
    assert.deepEqual(api.desktop.caps, ["auth.google", "openExternal"]);
    assert.equal(api.desktop.version, "9.9.9");
    assert.equal(typeof api.auth.google, "function");
    assert.notOk("run" in api);
    // The merge keeps a namespace the page already created (the assistant's API).
    const page = { darknode: { control: 1 } };
    vm.runInNewContext("(" + c.executed[0].func.toString() + ")(api)", { window: page, api });
    assert.equal(page.darknode.control, 1);
    assert.equal(page.darknode.desktop.version, "9.9.9");
  });
  test("a window.open(\"\") report window (about:blank, opener's origin) gets nothing", () => {
    const c = runPreload({ argv: WEB_ARGS, origin: APP, protocol: "about:", href: "about:blank" });
    assert.equal(c.exposed.length + c.executed.length, 0);
  });
  test("tool iframe on the app origin gets nothing", () => {
    const c = runPreload({ argv: WEB_ARGS, origin: APP, protocol: "http:", top: false });
    assert.equal(c.exposed.length + c.executed.length, 0);
  });
  for (const o of ["https://darknode.ai", "http://localhost:47914", "https://sentinel-b4194.firebaseapp.com", "null"]) {
    test(`other origin ${o} gets nothing`, () => {
      const c = runPreload({ argv: WEB_ARGS, origin: o, protocol: o.split(":")[0] + ":" });
      assert.equal(c.exposed.length + c.executed.length, 0);
    });
  }
  test("classic renderer (file:, top) keeps its bridge", () => {
    const c = runPreload({ argv: [], origin: "null", protocol: "file:" });
    assert.equal(c.exposed.length, 1);
    assert.equal(c.exposed[0].k, "darknode");
    assert.equal(typeof c.exposed[0].api.run, "function");
  });
  test("classic preload on a web page exposes nothing", () => {
    const c = runPreload({ argv: [], origin: "https://example.com", protocol: "https:" });
    assert.equal(c.exposed.length + c.executed.length, 0);
  });
  test("web-shell args without an origin expose nothing", () => {
    const c = runPreload({ argv: ["--dn-shell=web"], origin: APP, protocol: "http:" });
    assert.equal(c.exposed.length + c.executed.length, 0);
  });
});
