"use strict";
// Autonomous background updates for the packaged app.
//
// Replacing a running install safely is hard, so we use electron-updater rather
// than hand-rolling a download-and-swap (which can corrupt an install). It reads
// the GitHub release feed electron-builder publishes (latest.yml / latest-mac.yml
// / latest-linux.yml) and:
//   - runs only in a packaged build (never under `npm start`),
//   - downloads a newer version in the background,
//   - installs it silently the next time the user quits the app
//     (autoInstallOnAppQuit), so they are never interrupted,
//   - streams its state to the renderer so the UI can offer an OPTIONAL
//     "restart now" — it never forces a restart,
//   - stays quiet on errors. An unsigned macOS build, a .deb package, or simply
//     no release yet all mean "can't auto-update on this install"; that is not a
//     problem to nag the user about.
//
// Opt out entirely with DARKNODE_NO_UPDATE=1.

let _autoUpdater = null;
function updater() {
  if (!_autoUpdater) _autoUpdater = require("electron-updater").autoUpdater;
  return _autoUpdater;
}

function initAutoUpdate(getWin, app) {
  if (!app || !app.isPackaged) return;            // dev runs never self-update
  if (process.env.DARKNODE_NO_UPDATE) return;

  let au;
  try { au = updater(); } catch (_) { return; }   // dependency missing -> no-op

  const send = (state) => {
    try { const w = getWin && getWin(); if (w && !w.isDestroyed()) w.webContents.send("app:update", state); } catch (_) {}
  };

  au.autoDownload = true;           // fetch the update in the background
  au.autoInstallOnAppQuit = true;   // apply it on the next quit, no disruption
  au.allowDowngrade = false;
  try { au.logger = null; } catch (_) {}

  au.on("checking-for-update", () => send({ phase: "checking" }));
  au.on("update-available", (i) => send({ phase: "available", version: i && i.version }));
  au.on("update-not-available", () => send({ phase: "current" }));
  au.on("download-progress", (p) => send({ phase: "downloading", percent: Math.round((p && p.percent) || 0) }));
  au.on("update-downloaded", (i) => send({ phase: "ready", version: i && i.version }));
  au.on("error", (e) => send({ phase: "error", error: String((e && e.message) || e || "update failed") }));

  const check = () => { try { au.checkForUpdates().catch(() => {}); } catch (_) {} };
  setTimeout(check, 8000);                    // shortly after launch
  setInterval(check, 6 * 60 * 60 * 1000);     // and every 6 hours while running
}

// Called when the user accepts the optional "restart to update" affordance.
function quitAndInstall() {
  try { updater().quitAndInstall(false, true); } catch (_) {}
}

module.exports = { initAutoUpdate, quitAndInstall };
