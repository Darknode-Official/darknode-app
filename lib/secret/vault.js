"use strict";
// Darknode credential vault — DA-008 (S0).
//
// Secrets (model API keys, GitHub/Gmail tokens, service keys) must NOT sit in
// renderer localStorage as plaintext, where any process running as the same OS
// user — or anyone who copies the profile directory — can read them. This vault
// encrypts each value with an OS-backed key and writes only ciphertext to
// <cwd>/.nexus/secrets.enc (mode 0600).
//
// The crypto backend is injected so the module is testable without Electron and
// so the cross-user isolation property can be reproduced in a unit test:
//   backend = {
//     available(): boolean,              // is OS-backed encryption usable?
//     encrypt(plaintext: string): Buffer // -> ciphertext bytes
//     decrypt(cipher: Buffer): string    // -> plaintext (throws if not ours)
//     label?: string                     // e.g. "safeStorage:linux:libsecret"
//   }
// In the Electron main process the adapter wraps `safeStorage` (macOS Keychain,
// Windows DPAPI, Linux libsecret/kwallet). Because safeStorage's key is bound to
// the current OS user's keychain, a *different* OS user's safeStorage cannot
// decrypt this file — reproduced in test by handing vault B a backend whose key
// differs from vault A's.
//
// Fail-closed: if the backend is unavailable, set() REFUSES rather than silently
// storing plaintext, unless the caller explicitly opts into an insecure fallback
// (which is recorded per-entry and surfaced by list()/mode()).
//
// Verified by test/secret/vault.test.mjs.

const fs = require("fs"), path = require("path");

function createVault(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const backend = opts.backend || null;
  const allowInsecure = !!opts.allowInsecure;
  const file = path.join(cwd, ".nexus", "secrets.enc");

  const available = () => { try { return !!(backend && backend.available && backend.available()); } catch (_) { return false; } };

  function _loadRaw() {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return { v: 1, entries: {} }; }
  }
  function _saveRaw(store) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    // ensure mode even if the file pre-existed with looser perms
    try { fs.chmodSync(tmp, 0o600); } catch (_) {}
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }

  // mode(): how values are being protected right now.
  function mode() {
    if (available()) return { ok: true, mode: "os", backend: (backend && backend.label) || "os-backed", insecure: false };
    if (allowInsecure) return { ok: true, mode: "insecure-plaintext", backend: "none", insecure: true };
    return { ok: false, mode: "unavailable", backend: "none", insecure: false };
  }

  // set(name, value) -> { ok } | { ok:false, error }
  function set(name, value) {
    name = String(name || "").trim();
    if (!name) return { ok: false, error: "secret name required" };
    const plain = String(value == null ? "" : value);
    const store = _loadRaw();
    if (available()) {
      let cipher;
      try { cipher = backend.encrypt(plain); } catch (e) { return { ok: false, error: "encrypt failed: " + ((e && e.message) || e) }; }
      store.entries[name] = { enc: Buffer.from(cipher).toString("base64"), insecure: false, updatedAt: new Date().toISOString() };
    } else if (allowInsecure) {
      store.entries[name] = { plain: Buffer.from(plain, "utf8").toString("base64"), insecure: true, updatedAt: new Date().toISOString() };
    } else {
      return { ok: false, error: "OS-backed encryption is unavailable; refusing to store a secret in plaintext (pass allowInsecure to override)" };
    }
    try { _saveRaw(store); } catch (e) { return { ok: false, error: "write failed: " + ((e && e.message) || e) }; }
    return { ok: true, mode: store.entries[name].insecure ? "insecure-plaintext" : "os" };
  }

  // get(name) -> plaintext string, or null if absent / undecryptable by this backend.
  function get(name) {
    name = String(name || "").trim();
    const e = _loadRaw().entries[name];
    if (!e) return null;
    if (e.enc != null) {
      if (!available()) return null; // cannot decrypt without the backend
      try { return backend.decrypt(Buffer.from(e.enc, "base64")); } catch (_) { return null; } // another user's key -> fails here
    }
    if (e.plain != null) return Buffer.from(e.plain, "base64").toString("utf8");
    return null;
  }

  function has(name) { return !!_loadRaw().entries[String(name || "").trim()]; }

  // list() -> metadata only; NEVER the values.
  function list() {
    const es = _loadRaw().entries;
    return Object.keys(es).map((name) => ({ name, insecure: !!es[name].insecure, protected: es[name].enc != null, updatedAt: es[name].updatedAt || null }));
  }

  function remove(name) {
    name = String(name || "").trim();
    const store = _loadRaw();
    const had = Object.prototype.hasOwnProperty.call(store.entries, name);
    delete store.entries[name];
    try { _saveRaw(store); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true, removed: had ? 1 : 0 };
  }

  return { set, get, has, list, remove, mode, available, file };
}

// Build the Electron adapter from a `safeStorage` object (passed in so this file
// never hard-depends on electron and stays unit-testable).
function electronBackend(safeStorage, platformLabel) {
  return {
    label: "safeStorage" + (platformLabel ? ":" + platformLabel : ""),
    available: () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
}

module.exports = { createVault, electronBackend };
