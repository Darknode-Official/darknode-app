// Darknode toolkit — hashing & checksums.
//
// Pure, dual-environment. Non-cryptographic checksums (crc32, fnv1a, djb2,
// sdbm, adler32) and the Luhn algorithm are implemented here and work anywhere.
// Cryptographic digests (md5/sha1/sha256/sha512) delegate to Node's crypto in
// the main process / tests; in a plain browser context they are omitted (the
// renderer hashes via IPC instead). Text is hashed as UTF-8.
//
// Verified by test/toolkit/hashing.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const _enc = new TextEncoder();
  const bytes = (s) => (s instanceof Uint8Array ? s : _enc.encode(String(s)));
  const toHex32 = (n) => (n >>> 0).toString(16).padStart(8, "0");

  // ---- CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) --------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(input) {
    const b = bytes(input);
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const crc32Hex = (s) => toHex32(crc32(s));

  // ---- FNV-1a (32-bit) ----------------------------------------------------
  function fnv1a(input) {
    const b = bytes(input);
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const fnv1aHex = (s) => toHex32(fnv1a(s));

  // ---- djb2 / sdbm (classic string hashes) --------------------------------
  function djb2(input) {
    const b = bytes(input);
    let h = 5381;
    for (let i = 0; i < b.length; i++) h = (Math.imul(h, 33) + b[i]) >>> 0;
    return h >>> 0;
  }
  function sdbm(input) {
    const b = bytes(input);
    let h = 0;
    for (let i = 0; i < b.length; i++) h = (b[i] + Math.imul(h, 65599)) >>> 0;
    return h >>> 0;
  }

  // ---- Adler-32 -----------------------------------------------------------
  function adler32(input) {
    const b = bytes(input);
    const MOD = 65521;
    let a = 1, s = 0;
    for (let i = 0; i < b.length; i++) { a = (a + b[i]) % MOD; s = (s + a) % MOD; }
    return ((s << 16) | a) >>> 0;
  }
  const adler32Hex = (s) => toHex32(adler32(s));

  // ---- Luhn (mod-10) ------------------------------------------------------
  function luhnSum(digits) {
    let sum = 0, alt = false;
    for (let i = String(digits).length - 1; i >= 0; i--) {
      let d = String(digits).charCodeAt(i) - 48;
      if (d < 0 || d > 9) throw new Error("luhn: non-digit input");
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum;
  }
  function luhnValid(num) {
    const d = String(num).replace(/[\s-]/g, "");
    if (!/^\d+$/.test(d)) return false;
    return luhnSum(d) % 10 === 0;
  }
  function luhnCheckDigit(partial) {
    const d = String(partial).replace(/[\s-]/g, "");
    if (!/^\d+$/.test(d)) return null;
    return (10 - (luhnSum(d + "0") % 10)) % 10;
  }
  function luhnGenerate(partial) {
    const cd = luhnCheckDigit(partial);
    return cd === null ? null : String(partial).replace(/[\s-]/g, "") + cd;
  }

  // ---- Cryptographic digests (Node main process / tests only) -------------
  let _nodeCrypto = null;
  try { _nodeCrypto = (typeof require === "function") ? require("crypto") : null; } catch (_) { _nodeCrypto = null; }
  const hasNodeCrypto = !!_nodeCrypto;

  function _digest(algo, input) {
    if (!_nodeCrypto) throw new Error(algo + " requires the Node crypto module (use IPC in the renderer)");
    return _nodeCrypto.createHash(algo).update(Buffer.from(bytes(input))).digest("hex");
  }
  const md5 = (s) => _digest("md5", s);
  const sha1 = (s) => _digest("sha1", s);
  const sha256 = (s) => _digest("sha256", s);
  const sha512 = (s) => _digest("sha512", s);
  const hash = (algo, s) => _digest(String(algo).toLowerCase().replace(/-/g, ""), s);

  return {
    crc32, crc32Hex, fnv1a, fnv1aHex, djb2, sdbm, adler32, adler32Hex,
    luhnSum, luhnValid, luhnCheckDigit, luhnGenerate,
    hasNodeCrypto, md5, sha1, sha256, sha512, hash,
  };
});
