// Darknode toolkit — encoding / decoding.
//
// Pure, dependency-free, dual-environment (CommonJS for main process + Node
// tests; attaches to window.DarknodeToolkit in the renderer). All text I/O is
// UTF-8 via TextEncoder/TextDecoder (present in both Node 20 and the browser),
// so multi-byte input round-trips correctly. Byte-oriented helpers accept and
// return Uint8Array; string helpers wrap them.
//
// Verified by test/toolkit/encoding.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const _enc = new TextEncoder();
  const _dec = new TextDecoder("utf-8", { fatal: false });

  const utf8Bytes = (s) => _enc.encode(String(s));
  const bytesToUtf8 = (b) => _dec.decode(b instanceof Uint8Array ? b : Uint8Array.from(b));

  // ---- Base64 (RFC 4648) --------------------------------------------------
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_INV = (() => { const m = {}; for (let i = 0; i < B64.length; i++) m[B64[i]] = i; return m; })();

  function base64EncodeBytes(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
      const n = (b0 << 16) | ((has1 ? b1 : 0) << 8) | (has2 ? b2 : 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (has1 ? B64[(n >> 6) & 63] : "=") + (has2 ? B64[n & 63] : "=");
    }
    return out;
  }

  function base64DecodeToBytes(b64) {
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, "");
    const clean = s.replace(/=+$/, "");
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = B64_INV[clean[i]], c1 = B64_INV[clean[i + 1]];
      const c2 = clean[i + 2] !== undefined ? B64_INV[clean[i + 2]] : undefined;
      const c3 = clean[i + 3] !== undefined ? B64_INV[clean[i + 3]] : undefined;
      if (c0 === undefined || c1 === undefined) throw new Error("invalid base64");
      out.push(((c0 << 2) | (c1 >> 4)) & 0xff);
      if (c2 !== undefined) out.push(((c1 << 4) | (c2 >> 2)) & 0xff);
      if (c3 !== undefined) out.push(((c2 << 6) | c3) & 0xff);
    }
    return Uint8Array.from(out);
  }

  const base64Encode = (str) => base64EncodeBytes(utf8Bytes(str));
  const base64Decode = (b64) => bytesToUtf8(base64DecodeToBytes(b64));
  const base64UrlEncode = (str) => base64Encode(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const base64UrlDecode = (b64) => base64Decode(String(b64).replace(/-/g, "+").replace(/_/g, "/"));

  // ---- Base32 (RFC 4648) --------------------------------------------------
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const B32_INV = (() => { const m = {}; for (let i = 0; i < B32.length; i++) m[B32[i]] = i; return m; })();

  function base32Encode(str) {
    const bytes = utf8Bytes(str);
    let bits = 0, val = 0, out = "";
    for (const b of bytes) {
      val = (val << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    while (out.length % 8 !== 0) out += "=";
    return out;
  }

  function base32Decode(s) {
    const clean = String(s).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
    let bits = 0, val = 0; const out = [];
    for (const ch of clean) {
      const idx = B32_INV[ch];
      if (idx === undefined) throw new Error("invalid base32");
      val = (val << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return bytesToUtf8(Uint8Array.from(out));
  }

  // ---- Base58 (Bitcoin alphabet) -----------------------------------------
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58Encode(str) {
    const bytes = utf8Bytes(str);
    let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const digits = []; // big-endian base-58 digits of the non-zero remainder
    for (let i = zeros; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "1".repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }

  function base58Decode(s) {
    s = String(s);
    let zeros = 0; while (zeros < s.length && s[zeros] === "1") zeros++;
    const bytes = []; // little-endian base-256 digits of the decoded remainder
    for (let i = zeros; i < s.length; i++) {
      const val = B58.indexOf(s[i]);
      if (val < 0) throw new Error("invalid base58");
      let carry = val;
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return bytesToUtf8(out);
  }

  // ---- Hex ----------------------------------------------------------------
  function hexEncode(str, sep = "") {
    return [...utf8Bytes(str)].map((b) => b.toString(16).padStart(2, "0")).join(sep);
  }
  function hexDecode(hex) {
    const clean = String(hex).replace(/(^0x)|[\s:,-]/gi, "");
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("invalid hex");
    const out = clean.length ? clean.match(/.{2}/g).map((h) => parseInt(h, 16)) : [];
    return bytesToUtf8(Uint8Array.from(out));
  }

  // ---- Binary / decimal text ---------------------------------------------
  const toBinary = (str, sep = " ") => [...utf8Bytes(str)].map((b) => b.toString(2).padStart(8, "0")).join(sep);
  function fromBinary(bin) {
    const groups = String(bin).trim().split(/\s+/).filter(Boolean);
    if (!groups.every((g) => /^[01]{1,8}$/.test(g))) throw new Error("invalid binary");
    return bytesToUtf8(Uint8Array.from(groups.map((g) => parseInt(g, 2))));
  }
  const toDecimal = (str, sep = " ") => [...utf8Bytes(str)].map((b) => String(b)).join(sep);

  // ---- URL / HTML ---------------------------------------------------------
  const urlEncode = (s) => encodeURIComponent(String(s));
  const urlDecode = (s) => decodeURIComponent(String(s).replace(/\+/g, " "));

  const HTML_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const HTML_UNMAP = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", "#x27": "'" };
  const htmlEncode = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
  const htmlDecode = (s) => String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") { const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
    return HTML_UNMAP[e] !== undefined ? HTML_UNMAP[e] : m;
  });

  // ---- ROT-N / ROT13 ------------------------------------------------------
  const rotN = (n, t) => { n = (((n % 26) + 26) % 26); return String(t).replace(/[a-zA-Z]/g, (ch) => { const base = ch <= "Z" ? 65 : 97; return String.fromCharCode(((ch.charCodeAt(0) - base + n) % 26) + base); }); };
  const rot13 = (t) => rotN(13, t);
  // ROT47 covers printable ASCII 33..126.
  const rot47 = (t) => String(t).replace(/[!-~]/g, (ch) => String.fromCharCode(33 + ((ch.charCodeAt(0) - 33 + 47) % 94)));

  // ---- Morse --------------------------------------------------------------
  const MORSE = { A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..", 0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-", '"': ".-..-.", "$": "...-..-", "@": ".--.-." };
  const MORSE_INV = (() => { const m = {}; for (const k in MORSE) m[MORSE[k]] = k; return m; })();
  const toMorse = (s) => String(s).toUpperCase().split("").map((c) => c === " " ? "/" : (MORSE[c] || "")).filter((x) => x !== "").join(" ");
  const fromMorse = (s) => String(s).trim().split(/\s+/).map((code) => code === "/" ? " " : (MORSE_INV[code] || "")).join("");

  return {
    utf8Bytes, bytesToUtf8,
    base64Encode, base64Decode, base64EncodeBytes, base64DecodeToBytes, base64UrlEncode, base64UrlDecode,
    base32Encode, base32Decode,
    base58Encode, base58Decode,
    hexEncode, hexDecode,
    toBinary, fromBinary, toDecimal,
    urlEncode, urlDecode, htmlEncode, htmlDecode,
    rotN, rot13, rot47,
    toMorse, fromMorse,
  };
});
