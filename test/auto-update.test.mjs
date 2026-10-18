// Unit tests for lib/auto-update.js — the autonomous background updater wiring.
// We only exercise the guard paths that never touch electron-updater (requiring
// it and letting it arm its 6-hour setInterval would keep the test process
// alive). The packaged path only ever runs inside a real Electron build.
// A function that is expected "not to throw" is simply called: an uncaught throw
// fails the test on its own.
import { test, group, assert } from "./harness.mjs";
import { createRequire } from "node:module";
const AU = createRequire(import.meta.url)("../lib/auto-update.js");

group("auto-update: safe exports + guards", () => {
  test("exports the two functions", () => {
    assert.equal(typeof AU.initAutoUpdate, "function");
    assert.equal(typeof AU.quitAndInstall, "function");
  });

  test("does nothing in a dev (non-packaged) build — never reaches for the window", () => {
    let touchedWin = false;
    AU.initAutoUpdate(() => { touchedWin = true; return null; }, { isPackaged: false });
    assert.notOk(touchedWin, "no update activity, so getWin is never called");
  });

  test("does nothing when app is missing", () => {
    AU.initAutoUpdate(() => null, undefined);
    AU.initAutoUpdate(() => null, null);
    assert.ok(true, "returned without throwing");
  });

  test("honours DARKNODE_NO_UPDATE even in a packaged build", () => {
    const prev = process.env.DARKNODE_NO_UPDATE;
    process.env.DARKNODE_NO_UPDATE = "1";
    let touchedWin = false;
    try {
      AU.initAutoUpdate(() => { touchedWin = true; return null; }, { isPackaged: true });
      assert.notOk(touchedWin, "opt-out short-circuits before any updater work");
    } finally {
      if (prev === undefined) delete process.env.DARKNODE_NO_UPDATE; else process.env.DARKNODE_NO_UPDATE = prev;
    }
  });

  test("quitAndInstall never throws, even when the updater cannot run", () => {
    AU.quitAndInstall();
    assert.ok(true, "swallowed any updater failure");
  });
});
