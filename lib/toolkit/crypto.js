// Darknode toolkit — classic / lightweight ciphers.
//
// Pure, dual-environment. These are CTF / puzzle / obfuscation ciphers, NOT
// secure cryptography — for real encryption use Node crypto (see hashing.js
// digests and the main-process crypto IPC). Text is treated as UTF-8 for XOR
// (byte-level) and as Latin letters for the alphabetic ciphers.
//
// Verified by test/toolkit/crypto.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ---- XOR (byte-level, key repeats) --------------------------------------
  function xorBytes(key, data) {
    const k = _enc.encode(String(key));
    const d = data instanceof Uint8Array ? data : _enc.encode(String(data));
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i] ^ (k.length ? k[i % k.length] : 0);
    return out;
  }
  const xorHex = (key, text) => [...xorBytes(key, text)].map((b) => b.toString(16).padStart(2, "0")).join("");
  function xorFromHex(key, hex) {
    const clean = String(hex).replace(/\s+/g, "");
    if (clean.length % 2 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("input is not valid hex");
    const d = Uint8Array.from(clean.match(/.{2}/g) || [], (h) => parseInt(h, 16));
    return _dec.decode(xorBytes(key, d));
  }

  // ---- Caesar / shift -----------------------------------------------------
  const caesar = (shift, text) => {
    const n = (((shift % 26) + 26) % 26);
    return String(text).replace(/[a-zA-Z]/g, (ch) => { const base = ch <= "Z" ? 65 : 97; return String.fromCharCode(((ch.charCodeAt(0) - base + n) % 26) + base); });
  };
  const caesarDecrypt = (shift, text) => caesar(-shift, text);

  // ---- Atbash (a<->z), self-inverse --------------------------------------
  const atbash = (text) => String(text).replace(/[a-zA-Z]/g, (ch) => { const base = ch <= "Z" ? 65 : 97; return String.fromCharCode(base + 25 - (ch.charCodeAt(0) - base)); });

  // ---- Vigenère -----------------------------------------------------------
  function _vigenere(key, text, dir) {
    const k = String(key).replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (!k.length) throw new Error("vigenère: key must contain letters");
    let ki = 0;
    return String(text).replace(/[a-zA-Z]/g, (ch) => {
      const base = ch <= "Z" ? 65 : 97;
      const shift = (k.charCodeAt(ki % k.length) - 97) * dir;
      ki++;
      return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26 + 26) % 26 + base);
    });
  }
  const vigenereEncrypt = (key, text) => _vigenere(key, text, 1);
  const vigenereDecrypt = (key, text) => _vigenere(key, text, -1);

  // ---- A1Z26 (letter <-> number) -----------------------------------------
  const a1z26Encode = (text, sep = " ") => String(text).toLowerCase().replace(/[^a-z]/g, "").split("").map((c) => c.charCodeAt(0) - 96).join(sep);
  const a1z26Decode = (nums) => String(nums).trim().split(/[^0-9]+/).filter(Boolean).map((n) => { const v = parseInt(n, 10); if (v < 1 || v > 26) throw new Error("a1z26: out of range"); return String.fromCharCode(96 + v); }).join("");

  // ---- Rail fence ---------------------------------------------------------
  function railFenceEncrypt(rails, text) {
    rails = parseInt(rails, 10);
    if (!(rails >= 2)) throw new Error("rail fence: need >= 2 rails");
    const rows = Array.from({ length: rails }, () => "");
    let r = 0, dir = 1;
    for (const ch of String(text)) {
      rows[r] += ch;
      if (r === 0) dir = 1; else if (r === rails - 1) dir = -1;
      r += dir;
    }
    return rows.join("");
  }
  function railFenceDecrypt(rails, cipher) {
    rails = parseInt(rails, 10);
    if (!(rails >= 2)) throw new Error("rail fence: need >= 2 rails");
    const s = String(cipher);
    const pattern = new Array(s.length);
    let r = 0, dir = 1;
    for (let i = 0; i < s.length; i++) { pattern[i] = r; if (r === 0) dir = 1; else if (r === rails - 1) dir = -1; r += dir; }
    const counts = new Array(rails).fill(0);
    for (const p of pattern) counts[p]++;
    const rowStrings = []; let idx = 0;
    for (let i = 0; i < rails; i++) { rowStrings[i] = s.slice(idx, idx + counts[i]); idx += counts[i]; }
    const rowPos = new Array(rails).fill(0);
    let out = "";
    for (let i = 0; i < s.length; i++) { const p = pattern[i]; out += rowStrings[p][rowPos[p]++]; }
    return out;
  }

  return {
    xorBytes, xorHex, xorFromHex,
    caesar, caesarDecrypt, atbash,
    vigenereEncrypt, vigenereDecrypt,
    a1z26Encode, a1z26Decode,
    railFenceEncrypt, railFenceDecrypt,
  };
});
