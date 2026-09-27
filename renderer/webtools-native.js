// webtools-native.js — the app's OWN offline tool engine.
// Every tool here RUNS locally in the app (no internet, no darknode.ai webview),
// which is the whole point: the website can only show these; the app can run them
// on your machine, instantly and privately. window.WT_NATIVE is a list of
// [category, tools[]] where each tool is { id, name, desc, fields?, run }.
//   run(input, opts) -> string | Promise<string>   (throw to report an error)
//   fields: extra inputs besides the main textarea, [{ k, label, ph?, type?, options?, def? }]
(function () {
  "use strict";
  const te = new TextEncoder(), td = new TextDecoder();
  const bytes = (s) => te.encode(s);
  const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (s) => new Uint8Array((s.trim().replace(/[^0-9a-fA-F]/g, "").match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));

  // ---- subtle-crypto digests (SHA family) ----
  async function digest(algo, s) { return hex(new Uint8Array(await crypto.subtle.digest(algo, bytes(s)))); }

  // ---- MD5 (compact, correct; subtle has no MD5) ----
  function md5(str) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function add(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
    function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    const b = bytes(str), n = b.length, words = [];
    for (let i = 0; i < n; i++) words[i >> 2] |= b[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[(((n + 8) >> 6) + 1) * 16 - 2] = n * 8;
    let a = 1732584193, bb = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < words.length; i += 16) {
      const oa = a, ob = bb, oc = c, od = d, w = (j) => words[i + j] | 0;
      a = ff(a, bb, c, d, w(0), 7, -680876936); d = ff(d, a, bb, c, w(1), 12, -389564586); c = ff(c, d, a, bb, w(2), 17, 606105819); bb = ff(bb, c, d, a, w(3), 22, -1044525330);
      a = ff(a, bb, c, d, w(4), 7, -176418897); d = ff(d, a, bb, c, w(5), 12, 1200080426); c = ff(c, d, a, bb, w(6), 17, -1473231341); bb = ff(bb, c, d, a, w(7), 22, -45705983);
      a = ff(a, bb, c, d, w(8), 7, 1770035416); d = ff(d, a, bb, c, w(9), 12, -1958414417); c = ff(c, d, a, bb, w(10), 17, -42063); bb = ff(bb, c, d, a, w(11), 22, -1990404162);
      a = ff(a, bb, c, d, w(12), 7, 1804603682); d = ff(d, a, bb, c, w(13), 12, -40341101); c = ff(c, d, a, bb, w(14), 17, -1502002290); bb = ff(bb, c, d, a, w(15), 22, 1236535329);
      a = gg(a, bb, c, d, w(1), 5, -165796510); d = gg(d, a, bb, c, w(6), 9, -1069501632); c = gg(c, d, a, bb, w(11), 14, 643717713); bb = gg(bb, c, d, a, w(0), 20, -373897302);
      a = gg(a, bb, c, d, w(5), 5, -701558691); d = gg(d, a, bb, c, w(10), 9, 38016083); c = gg(c, d, a, bb, w(15), 14, -660478335); bb = gg(bb, c, d, a, w(4), 20, -405537848);
      a = gg(a, bb, c, d, w(9), 5, 568446438); d = gg(d, a, bb, c, w(14), 9, -1019803690); c = gg(c, d, a, bb, w(3), 14, -187363961); bb = gg(bb, c, d, a, w(8), 20, 1163531501);
      a = gg(a, bb, c, d, w(13), 5, -1444681467); d = gg(d, a, bb, c, w(2), 9, -51403784); c = gg(c, d, a, bb, w(7), 14, 1735328473); bb = gg(bb, c, d, a, w(12), 20, -1926607734);
      a = hh(a, bb, c, d, w(5), 4, -378558); d = hh(d, a, bb, c, w(8), 11, -2022574463); c = hh(c, d, a, bb, w(11), 16, 1839030562); bb = hh(bb, c, d, a, w(14), 23, -35309556);
      a = hh(a, bb, c, d, w(1), 4, -1530992060); d = hh(d, a, bb, c, w(4), 11, 1272893353); c = hh(c, d, a, bb, w(7), 16, -155497632); bb = hh(bb, c, d, a, w(10), 23, -1094730640);
      a = hh(a, bb, c, d, w(13), 4, 681279174); d = hh(d, a, bb, c, w(0), 11, -358537222); c = hh(c, d, a, bb, w(3), 16, -722521979); bb = hh(bb, c, d, a, w(6), 23, 76029189);
      a = hh(a, bb, c, d, w(9), 4, -640364487); d = hh(d, a, bb, c, w(12), 11, -421815835); c = hh(c, d, a, bb, w(15), 16, 530742520); bb = hh(bb, c, d, a, w(2), 23, -995338651);
      a = ii(a, bb, c, d, w(0), 6, -198630844); d = ii(d, a, bb, c, w(7), 10, 1126891415); c = ii(c, d, a, bb, w(14), 15, -1416354905); bb = ii(bb, c, d, a, w(5), 21, -57434055);
      a = ii(a, bb, c, d, w(12), 6, 1700485571); d = ii(d, a, bb, c, w(3), 10, -1894986606); c = ii(c, d, a, bb, w(10), 15, -1051523); bb = ii(bb, c, d, a, w(1), 21, -2054922799);
      a = ii(a, bb, c, d, w(8), 6, 1873313359); d = ii(d, a, bb, c, w(15), 10, -30611744); c = ii(c, d, a, bb, w(6), 15, -1560198380); bb = ii(bb, c, d, a, w(13), 21, 1309151649);
      a = ii(a, bb, c, d, w(4), 6, -145523070); d = ii(d, a, bb, c, w(11), 10, -1120210379); c = ii(c, d, a, bb, w(2), 15, 718787259); bb = ii(bb, c, d, a, w(9), 21, -343485551);
      a = add(a, oa); bb = add(bb, ob); c = add(c, oc); d = add(d, od);
    }
    return [a, bb, c, d].map((x) => { let s = ""; for (let i = 0; i < 4; i++) s += ((x >> (i * 8)) & 0xff).toString(16).padStart(2, "0"); return s; }).join("");
  }

  // ---- CRC32 ----
  const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(s) { const b = bytes(s); let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0"); }

  // ---- Base32 (RFC 4648) ----
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32enc(s) { const b = bytes(s); let bits = 0, val = 0, out = ""; for (let i = 0; i < b.length; i++) { val = (val << 8) | b[i]; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; while (out.length % 8) out += "="; return out; }
  function base32dec(s) { s = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, ""); let bits = 0, val = 0; const out = []; for (const ch of s) { const idx = B32.indexOf(ch); if (idx < 0) throw new Error("invalid base32 character: " + ch); val = (val << 5) | idx; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } } return td.decode(new Uint8Array(out)); }

  // ---- Morse ----
  const MORSE = { A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..", 0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-", '"': ".-..-.", "$": "...-..-", "@": ".--.-.", " ": "/" };
  const UNMORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s.trim().replace(/\s/g, ""))));
  const clean = (s) => (s == null ? "" : String(s));

  const NB = { bin: 2, oct: 8, dec: 10, hex: 16 };

  const cat = (name, tools) => [name, tools];

  const CATALOG = [
    cat("Encoding & Data", [
      { id: "base64-encode", name: "Base64 encode", desc: "Text to Base64", run: (s) => b64enc(s) },
      { id: "base64-decode", name: "Base64 decode", desc: "Base64 to text", run: (s) => b64dec(s) },
      { id: "base64url-encode", name: "Base64URL encode", desc: "URL-safe Base64", run: (s) => b64enc(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") },
      { id: "base64url-decode", name: "Base64URL decode", desc: "URL-safe Base64 to text", run: (s) => b64dec(s.replace(/-/g, "+").replace(/_/g, "/")) },
      { id: "url-encode", name: "URL encode", desc: "Percent-encode a string", run: (s) => encodeURIComponent(s) },
      { id: "url-decode", name: "URL decode", desc: "Decode percent-encoding", run: (s) => decodeURIComponent(s) },
      { id: "html-encode", name: "HTML entity encode", desc: "Escape &, <, >, \", '", run: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") },
      { id: "html-decode", name: "HTML entity decode", desc: "Un-escape HTML entities", run: (s) => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; } },
      { id: "hex-encode", name: "Hex encode", desc: "Bytes to hex", run: (s) => hex(bytes(s)) },
      { id: "hex-decode", name: "Hex decode", desc: "Hex to text", run: (s) => td.decode(fromHex(s)) },
      { id: "binary-encode", name: "Text to binary", desc: "8-bit binary per byte", run: (s) => Array.from(bytes(s)).map((b) => b.toString(2).padStart(8, "0")).join(" ") },
      { id: "binary-decode", name: "Binary to text", desc: "Binary (spaces optional) to text", run: (s) => td.decode(new Uint8Array((s.replace(/[^01]/g, "").match(/.{1,8}/g) || []).map((b) => parseInt(b, 2)))) },
      { id: "base32-encode", name: "Base32 encode", desc: "RFC 4648 Base32", run: (s) => base32enc(s) },
      { id: "base32-decode", name: "Base32 decode", desc: "Base32 to text", run: (s) => base32dec(s) },
      { id: "rot13", name: "ROT13", desc: "Rotate letters by 13", run: (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)) },
      { id: "rot47", name: "ROT47", desc: "Rotate printable ASCII by 47", run: (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94))) },
      { id: "morse-encode", name: "Morse encode", desc: "Text to Morse code", run: (s) => s.toUpperCase().split("").map((c) => MORSE[c] != null ? MORSE[c] : "").filter(Boolean).join(" ") },
      { id: "morse-decode", name: "Morse decode", desc: "Morse code to text", run: (s) => s.trim().split(/\s+/).map((c) => UNMORSE[c] || (c === "/" ? " " : "")).join("") },
      { id: "unicode-escape", name: "Unicode escape", desc: "Chars to \\uXXXX", run: (s) => s.replace(/[\s\S]/g, (c) => { const n = c.charCodeAt(0); return n < 128 ? c : "\\u" + n.toString(16).padStart(4, "0"); }) },
      { id: "unicode-unescape", name: "Unicode unescape", desc: "\\uXXXX to chars", run: (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) },
      { id: "jwt-decode", name: "JWT decode", desc: "Decode a JWT's header and payload", run: (s) => { const p = s.trim().split("."); if (p.length < 2) throw new Error("not a JWT (need header.payload.signature)"); const d = (x) => JSON.stringify(JSON.parse(b64dec(x.replace(/-/g, "+").replace(/_/g, "/"))), null, 2); return "HEADER\n" + d(p[0]) + "\n\nPAYLOAD\n" + d(p[1]) + (p[2] ? "\n\nSIGNATURE\n" + p[2] : ""); } },
      { id: "json-format", name: "JSON prettify", desc: "Format/validate JSON", fields: [{ k: "indent", label: "Indent", type: "select", options: [["2", "2 spaces"], ["4", "4 spaces"], ["\t", "Tab"]], def: "2" }], run: (s, o) => JSON.stringify(JSON.parse(s), null, o.indent === "\t" ? "\t" : +o.indent) },
      { id: "json-minify", name: "JSON minify", desc: "Strip whitespace from JSON", run: (s) => JSON.stringify(JSON.parse(s)) },
      { id: "number-base", name: "Number base convert", desc: "Convert between bin/oct/dec/hex", fields: [{ k: "from", label: "From", type: "select", options: [["dec", "Decimal"], ["hex", "Hex"], ["bin", "Binary"], ["oct", "Octal"]], def: "dec" }, { k: "to", label: "To", type: "select", options: [["hex", "Hex"], ["dec", "Decimal"], ["bin", "Binary"], ["oct", "Octal"]], def: "hex" }], run: (s, o) => { const v = parseInt(s.trim().replace(/^0[xbo]/i, ""), NB[o.from]); if (isNaN(v)) throw new Error("not a valid " + o.from + " number"); return v.toString(NB[o.to]); } },
    ]),
    cat("Hashing & Checksums", [
      { id: "md5", name: "MD5", desc: "128-bit MD5 hash", run: (s) => md5(s) },
      { id: "sha1", name: "SHA-1", desc: "160-bit SHA-1 hash", run: (s) => digest("SHA-1", s) },
      { id: "sha256", name: "SHA-256", desc: "256-bit SHA-256 hash", run: (s) => digest("SHA-256", s) },
      { id: "sha384", name: "SHA-384", desc: "384-bit SHA-384 hash", run: (s) => digest("SHA-384", s) },
      { id: "sha512", name: "SHA-512", desc: "512-bit SHA-512 hash", run: (s) => digest("SHA-512", s) },
      { id: "crc32", name: "CRC32", desc: "32-bit CRC checksum", run: (s) => crc32(s) },
      { id: "all-hashes", name: "All hashes", desc: "MD5 + SHA family at once", run: async (s) => "MD5    " + md5(s) + "\nSHA1   " + await digest("SHA-1", s) + "\nSHA256 " + await digest("SHA-256", s) + "\nSHA512 " + await digest("SHA-512", s) + "\nCRC32  " + crc32(s) },
      { id: "hmac", name: "HMAC", desc: "Keyed hash (HMAC)", fields: [{ k: "algo", label: "Algorithm", type: "select", options: [["SHA-256", "SHA-256"], ["SHA-1", "SHA-1"], ["SHA-512", "SHA-512"]], def: "SHA-256" }, { k: "key", label: "Secret key", ph: "key" }], run: async (s, o) => { const k = await crypto.subtle.importKey("raw", bytes(o.key || ""), { name: "HMAC", hash: o.algo }, false, ["sign"]); return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(s)))); } },
      { id: "hash-identify", name: "Identify hash", desc: "Guess a hash type by shape", run: (s) => { const h = s.trim(); const L = h.length; if (!/^[0-9a-fA-F]+$/.test(h)) return "Not pure hex — could be bcrypt/argon2/base64. bcrypt starts $2a$/$2b$; argon2 starts $argon2."; const by = { 32: "MD5 / MD4 / NTLM", 40: "SHA-1", 56: "SHA-224", 64: "SHA-256", 96: "SHA-384", 128: "SHA-512", 8: "CRC32" }; return by[L] ? by[L] + "  (" + L + " hex chars)" : "Unknown (" + L + " hex chars)"; } },
    ]),
    cat("Ciphers", [
      { id: "caesar", name: "Caesar shift", desc: "Shift letters by N", fields: [{ k: "shift", label: "Shift", type: "number", def: "3" }], run: (s, o) => { const n = ((+o.shift % 26) + 26) % 26; return s.replace(/[a-z]/gi, (c) => { const base = c <= "Z" ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26) + base); }); } },
      { id: "vigenere-encode", name: "Vigenere encode", desc: "Keyword cipher", fields: [{ k: "key", label: "Keyword", ph: "SECRET" }], run: (s, o) => vigenere(s, o.key, 1) },
      { id: "vigenere-decode", name: "Vigenere decode", desc: "Decrypt keyword cipher", fields: [{ k: "key", label: "Keyword", ph: "SECRET" }], run: (s, o) => vigenere(s, o.key, -1) },
      { id: "atbash", name: "Atbash", desc: "Mirror the alphabet", run: (s) => s.replace(/[a-z]/gi, (c) => { const base = c <= "Z" ? 65 : 97; return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base)); }) },
      { id: "xor", name: "XOR cipher", desc: "XOR bytes with a key (hex output)", fields: [{ k: "key", label: "Key", ph: "key" }], run: (s, o) => { const k = bytes(o.key || ""); if (!k.length) throw new Error("key required"); const b = bytes(s); return hex(b.map((x, i) => x ^ k[i % k.length])); } },
      { id: "xor-hex", name: "XOR decrypt (hex)", desc: "XOR a hex string with a key", fields: [{ k: "key", label: "Key", ph: "key" }], run: (s, o) => { const k = bytes(o.key || ""); if (!k.length) throw new Error("key required"); const b = fromHex(s); return td.decode(b.map((x, i) => x ^ k[i % k.length])); } },
    ]),
    cat("Text & Format", [
      { id: "uppercase", name: "UPPERCASE", desc: "To upper case", run: (s) => s.toUpperCase() },
      { id: "lowercase", name: "lowercase", desc: "To lower case", run: (s) => s.toLowerCase() },
      { id: "titlecase", name: "Title Case", desc: "Capitalize each word", run: (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) },
      { id: "camelcase", name: "camelCase", desc: "To camelCase", run: (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()) },
      { id: "snakecase", name: "snake_case", desc: "To snake_case", run: (s) => s.trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase().replace(/^_|_$/g, "") },
      { id: "kebabcase", name: "kebab-case", desc: "To kebab-case", run: (s) => s.trim().replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "") },
      { id: "slugify", name: "Slugify", desc: "URL-friendly slug", run: (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") },
      { id: "reverse-text", name: "Reverse text", desc: "Reverse characters", run: (s) => [...s].reverse().join("") },
      { id: "sort-lines", name: "Sort lines", desc: "Sort lines alphabetically", fields: [{ k: "order", label: "Order", type: "select", options: [["asc", "A to Z"], ["desc", "Z to A"], ["len", "By length"]], def: "asc" }], run: (s, o) => { const L = s.split("\n"); if (o.order === "len") L.sort((a, b) => a.length - b.length); else { L.sort(); if (o.order === "desc") L.reverse(); } return L.join("\n"); } },
      { id: "dedupe-lines", name: "Unique lines", desc: "Remove duplicate lines", run: (s) => [...new Set(s.split("\n"))].join("\n") },
      { id: "remove-blank", name: "Remove blank lines", desc: "Drop empty lines", run: (s) => s.split("\n").filter((l) => l.trim()).join("\n") },
      { id: "trim-lines", name: "Trim lines", desc: "Strip leading/trailing spaces", run: (s) => s.split("\n").map((l) => l.trim()).join("\n") },
      { id: "count", name: "Count text", desc: "Lines, words, chars, bytes", run: (s) => "Lines: " + (s ? s.split("\n").length : 0) + "\nWords: " + (s.trim() ? s.trim().split(/\s+/).length : 0) + "\nChars: " + s.length + "\nBytes: " + bytes(s).length },
      { id: "word-freq", name: "Word frequency", desc: "Count each word", run: (s) => { const m = {}; (s.toLowerCase().match(/[a-z0-9']+/g) || []).forEach((w) => (m[w] = (m[w] || 0) + 1)); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([w, c]) => c + "\t" + w).join("\n"); } },
      { id: "js-escape", name: "JS string escape", desc: "Escape for a JS string literal", run: (s) => JSON.stringify(s).slice(1, -1) },
      { id: "js-unescape", name: "JS string unescape", desc: "Un-escape a JS string literal", run: (s) => JSON.parse('"' + s.replace(/^"|"$/g, "") + '"') },
    ]),
    cat("Generators", [
      { id: "uuid", name: "UUID v4", desc: "Random UUIDs", fields: [{ k: "count", label: "How many", type: "number", def: "1" }], run: (s, o) => Array.from({ length: Math.min(Math.max(+o.count || 1, 1), 500) }, () => crypto.randomUUID()).join("\n") },
      { id: "password", name: "Password", desc: "Strong random password", fields: [{ k: "len", label: "Length", type: "number", def: "20" }, { k: "sym", label: "Symbols", type: "select", options: [["1", "Yes"], ["0", "No"]], def: "1" }], run: (s, o) => { const len = Math.min(Math.max(+o.len || 20, 4), 256); let cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; if (o.sym !== "0") cs += "!@#$%^&*()-_=+[]{};:,.<>?"; const a = new Uint32Array(len); crypto.getRandomValues(a); return Array.from(a, (x) => cs[x % cs.length]).join(""); } },
      { id: "random-hex", name: "Random hex", desc: "Random hex bytes", fields: [{ k: "bytes", label: "Bytes", type: "number", def: "16" }], run: (s, o) => { const n = Math.min(Math.max(+o.bytes || 16, 1), 4096); const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); } },
      { id: "random-base64", name: "Random Base64", desc: "Random bytes as Base64", fields: [{ k: "bytes", label: "Bytes", type: "number", def: "24" }], run: (s, o) => { const n = Math.min(Math.max(+o.bytes || 24, 1), 4096); const a = new Uint8Array(n); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)); } },
      { id: "lorem", name: "Lorem ipsum", desc: "Placeholder paragraphs", fields: [{ k: "p", label: "Paragraphs", type: "number", def: "3" }], run: (s, o) => { const W = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" "); const sent = () => { const n = 8 + Math.floor(Math.random() * 8); let s2 = Array.from({ length: n }, () => W[Math.floor(Math.random() * W.length)]).join(" "); return s2[0].toUpperCase() + s2.slice(1) + "."; }; return Array.from({ length: Math.min(Math.max(+o.p || 3, 1), 50) }, () => Array.from({ length: 4 }, sent).join(" ")).join("\n\n"); } },
    ]),
    cat("Web & Dev", [
      { id: "url-parse", name: "URL parser", desc: "Break a URL into parts", run: (s) => { const u = new URL(s.trim()); const q = [...u.searchParams].map(([k, v]) => "    " + k + " = " + v).join("\n"); return "protocol " + u.protocol + "\nhost     " + u.host + "\npath     " + u.pathname + "\nquery:\n" + (q || "    (none)") + "\nhash     " + (u.hash || "(none)"); } },
      { id: "query-parse", name: "Query string parser", desc: "Parse a=1&b=2", run: (s) => [...new URLSearchParams(s.trim().replace(/^\?/, ""))].map(([k, v]) => k + " = " + v).join("\n") || "(empty)" },
      { id: "color-convert", name: "Color convert", desc: "HEX / RGB / HSL", run: (s) => colorConvert(s) },
      { id: "timestamp", name: "Unix timestamp", desc: "Epoch to/from date", fields: [{ k: "mode", label: "Direction", type: "select", options: [["to", "Timestamp to date"], ["from", "Date to timestamp"]], def: "to" }], run: (s, o) => { s = s.trim(); if (o.mode === "from") { const d = new Date(s || Date.now()); if (isNaN(d)) throw new Error("unparseable date"); return "seconds " + Math.floor(d.getTime() / 1000) + "\nmillis  " + d.getTime(); } let n = +s; if (!s) n = Date.now(); if (n < 1e12) n *= 1000; const d = new Date(n); if (isNaN(d)) throw new Error("unparseable timestamp"); return "UTC   " + d.toISOString() + "\nLocal " + d.toString(); } },
      { id: "regex-test", name: "Regex tester", desc: "Test a pattern against the input", fields: [{ k: "pattern", label: "Pattern", ph: "\\d+" }, { k: "flags", label: "Flags", ph: "gi", def: "g" }], run: (s, o) => { if (!o.pattern) throw new Error("pattern required"); const re = new RegExp(o.pattern, o.flags || ""); const m = s.match(re); if (!m) return "No match."; return m.length + " match(es):\n" + m.join("\n"); } },
      { id: "user-agent", name: "User-Agent parser", desc: "Rough browser/OS from a UA string", run: (s) => uaParse(s) },
      { id: "css-hex-rgb", name: "HEX to RGB", desc: "#rrggbb to rgb()", run: (s) => { const h = s.trim().replace("#", ""); if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error("expected #rrggbb"); return "rgb(" + parseInt(h.slice(0, 2), 16) + ", " + parseInt(h.slice(2, 4), 16) + ", " + parseInt(h.slice(4, 6), 16) + ")"; } },
    ]),
    cat("Network & IP", [
      { id: "ip-to-int", name: "IP to integer", desc: "Dotted IPv4 to a 32-bit int", run: (s) => { const p = s.trim().split("."); if (p.length !== 4 || p.some((x) => +x < 0 || +x > 255 || x === "")) throw new Error("not an IPv4 address"); return String(p.reduce((a, o) => a * 256 + +o, 0)); } },
      { id: "int-to-ip", name: "Integer to IP", desc: "32-bit int to dotted IPv4", run: (s) => { const n = +s.trim(); if (isNaN(n) || n < 0 || n > 4294967295) throw new Error("out of IPv4 range"); return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); } },
      { id: "cidr", name: "CIDR calculator", desc: "Network, broadcast, host range", run: (s) => cidrCalc(s) },
      { id: "netmask", name: "Prefix to netmask", desc: "/24 to 255.255.255.0", run: (s) => { const p = +s.trim().replace("/", ""); if (isNaN(p) || p < 0 || p > 32) throw new Error("prefix must be 0-32"); const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; return [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join(".") + "   (" + p + " bits, " + (p === 32 ? 1 : Math.pow(2, 32 - p)) + " addresses)"; } },
    ]),
    cat("Security", [
      { id: "entropy", name: "Shannon entropy", desc: "Bits of entropy in the input", run: (s) => { if (!s) return "0 bits"; const m = {}; for (const c of s) m[c] = (m[c] || 0) + 1; let h = 0; for (const k in m) { const p = m[k] / s.length; h -= p * Math.log2(p); } return h.toFixed(3) + " bits/char\n" + (h * s.length).toFixed(1) + " bits total\n" + Object.keys(m).length + " distinct symbols"; } },
      { id: "pw-strength", name: "Password strength", desc: "Estimate crack difficulty", run: (s) => { if (!s) return "empty"; let pool = 0; if (/[a-z]/.test(s)) pool += 26; if (/[A-Z]/.test(s)) pool += 26; if (/[0-9]/.test(s)) pool += 10; if (/[^a-zA-Z0-9]/.test(s)) pool += 32; const bits = s.length * Math.log2(pool || 1); const label = bits < 40 ? "Weak" : bits < 60 ? "Fair" : bits < 80 ? "Strong" : "Very strong"; return label + "\n" + bits.toFixed(0) + " bits of entropy\ncharset size " + pool + ", length " + s.length; } },
    ]),
  ];

  function vigenere(s, key, dir) { key = (key || "").replace(/[^a-z]/gi, ""); if (!key) throw new Error("keyword required"); let ki = 0; return s.replace(/[a-z]/gi, (c) => { const base = c <= "Z" ? 65 : 97; const k = key[ki % key.length].toUpperCase().charCodeAt(0) - 65; ki++; return String.fromCharCode(((c.charCodeAt(0) - base + dir * k + 26) % 26) + base); }); }

  function colorConvert(s) {
    s = s.trim(); let r, g, b;
    let m = s.match(/^#?([0-9a-fA-F]{6})$/) || s.match(/^#?([0-9a-fA-F]{3})$/);
    if (m) { let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join(""); r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
    else if ((m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
    else throw new Error("expected #hex or rgb(r,g,b)");
    const hx = "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const r1 = r / 255, g1 = g / 255, b1 = b / 255, mx = Math.max(r1, g1, b1), mn = Math.min(r1, g1, b1); let h = 0, sl = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; sl = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r1 ? (g1 - b1) / d + (g1 < b1 ? 6 : 0) : mx === g1 ? (b1 - r1) / d + 2 : (r1 - g1) / d + 4; h *= 60; }
    return "HEX  " + hx + "\nRGB  rgb(" + r + ", " + g + ", " + b + ")\nHSL  hsl(" + Math.round(h) + ", " + Math.round(sl * 100) + "%, " + Math.round(l * 100) + "%)";
  }

  function cidrCalc(s) {
    const [ip, pfxRaw] = s.trim().split("/"); const pfx = +pfxRaw; const p = ip.split(".");
    if (p.length !== 4 || isNaN(pfx) || pfx < 0 || pfx > 32) throw new Error("expected a.b.c.d/prefix, e.g. 192.168.1.0/24");
    const ipn = p.reduce((a, o) => a * 256 + (+o), 0) >>> 0;
    const mask = pfx === 0 ? 0 : (0xffffffff << (32 - pfx)) >>> 0;
    const net = (ipn & mask) >>> 0, bcast = (net | (~mask >>> 0)) >>> 0;
    const fmt = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    const total = pfx >= 31 ? Math.pow(2, 32 - pfx) : Math.pow(2, 32 - pfx);
    const usable = pfx >= 31 ? total : Math.max(total - 2, 0);
    return "Network    " + fmt(net) + "/" + pfx + "\nNetmask    " + fmt(mask) + "\nBroadcast  " + fmt(bcast) + "\nFirst host " + fmt(pfx >= 31 ? net : net + 1) + "\nLast host  " + fmt(pfx >= 31 ? bcast : bcast - 1) + "\nAddresses  " + total + " (" + usable + " usable)";
  }

  function uaParse(s) {
    s = s.trim(); if (!s) throw new Error("paste a User-Agent string");
    const os = /Windows NT 10/.test(s) ? "Windows 10/11" : /Windows NT/.test(s) ? "Windows" : /Android/.test(s) ? "Android" : /iPhone|iPad|iOS/.test(s) ? "iOS" : /Mac OS X/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "Unknown";
    let br = "Unknown"; let m;
    if ((m = s.match(/Edg\/([\d.]+)/))) br = "Edge " + m[1];
    else if ((m = s.match(/OPR\/([\d.]+)/))) br = "Opera " + m[1];
    else if ((m = s.match(/Firefox\/([\d.]+)/))) br = "Firefox " + m[1];
    else if ((m = s.match(/Chrome\/([\d.]+)/))) br = "Chrome " + m[1];
    else if ((m = s.match(/Version\/([\d.]+).*Safari/))) br = "Safari " + m[1];
    const mob = /Mobile|Android|iPhone/.test(s) ? "Mobile" : "Desktop";
    return "Browser  " + br + "\nOS       " + os + "\nType     " + mob;
  }

  window.WT_NATIVE = CATALOG;
})();
