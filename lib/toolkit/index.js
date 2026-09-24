// Darknode toolkit — barrel export.
//
// Aggregates the pure security helpers into one namespace so the main process
// can `require("./lib/toolkit")` and the renderer gets a single
// `window.DarknodeToolkit` after loading the modules. Each module is
// self-contained and individually tested; this just re-exports them, grouped
// and also flattened for convenience.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // In Node/main, require the siblings. In the browser they've already attached
  // themselves to window.DarknodeToolkit via their own UMD footers.
  function load(name) {
    try { if (typeof require === "function") return require("./" + name + ".js"); } catch (_) {}
    return (typeof self !== "undefined" && self.DarknodeToolkit) || {};
  }

  const encoding = load("encoding");
  const hashing = load("hashing");
  const crypto = load("crypto");
  const net = load("net");
  const forensics = load("forensics");

  // Flatten everything into one object too (last-writer-wins is fine — names are
  // unique across modules by design).
  const flat = Object.assign({}, encoding, hashing, crypto, net, forensics);

  return Object.assign(flat, { encoding, hashing, crypto, net, forensics });
});
