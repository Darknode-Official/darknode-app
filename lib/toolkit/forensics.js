// Darknode toolkit — lightweight forensics helpers.
//
// Pure, dual-environment. String extraction, a classic hexdump, Shannon entropy
// (bits/byte) with a verdict, and magic-byte file-type detection. Inputs may be
// a string (treated as UTF-8 bytes), a Uint8Array, or a byte array. In the
// desktop app these run over real file bytes read via IPC.
//
// Verified by test/toolkit/forensics.test.mjs.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.DarknodeToolkit = Object.assign(root.DarknodeToolkit || {}, api); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const _enc = new TextEncoder();
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (Array.isArray(input)) return Uint8Array.from(input);
    return _enc.encode(String(input));
  }

  // ---- Printable-string extraction ---------------------------------------
  // Runs of printable ASCII (0x20..0x7e) at least `min` chars long.
  function extractStrings(input, min = 4) {
    const b = toBytes(input);
    const out = [];
    let start = -1, cur = "";
    const flush = () => { if (cur.length >= min) out.push({ offset: start, text: cur }); start = -1; cur = ""; };
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c >= 0x20 && c <= 0x7e) { if (start < 0) start = i; cur += String.fromCharCode(c); }
      else flush();
    }
    flush();
    return out;
  }

  // ---- Hexdump (xxd / hexdump -C style) ----------------------------------
  function hexdump(input, width = 16) {
    const b = toBytes(input);
    const lines = [];
    for (let off = 0; off < b.length; off += width) {
      const slice = b.subarray(off, off + width);
      const hexParts = [];
      for (let i = 0; i < width; i++) {
        hexParts.push(i < slice.length ? slice[i].toString(16).padStart(2, "0") : "  ");
        if (i === (width >> 1) - 1) hexParts.push(""); // gutter between halves
      }
      const hex = hexParts.join(" ").replace(/\s+$/, "");
      const ascii = [...slice].map((c) => (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : ".").join("");
      lines.push(off.toString(16).padStart(8, "0") + "  " + hex.padEnd(width * 3, " ") + "  |" + ascii + "|");
    }
    if (!b.length) return "";
    lines.push(b.length.toString(16).padStart(8, "0"));
    return lines.join("\n");
  }

  // ---- Shannon entropy ----------------------------------------------------
  function shannonEntropy(input) {
    const b = toBytes(input);
    if (!b.length) return 0;
    const counts = new Array(256).fill(0);
    for (let i = 0; i < b.length; i++) counts[b[i]]++;
    let h = 0;
    for (const c of counts) { if (!c) continue; const p = c / b.length; h -= p * Math.log2(p); }
    return h;
  }
  function entropyVerdict(input) {
    const h = typeof input === "number" ? input : shannonEntropy(input);
    let verdict;
    if (h >= 7.5) verdict = "very high — likely encrypted or compressed";
    else if (h >= 6.5) verdict = "high — compressed / packed / random-ish";
    else if (h >= 4.5) verdict = "moderate — typical text / code / structured data";
    else if (h > 0) verdict = "low — repetitive or small-alphabet data";
    else verdict = "zero — single byte value / empty";
    return { entropy: h, bitsPerByte: Math.round(h * 1000) / 1000, verdict };
  }

  // ---- Magic-byte file typing --------------------------------------------
  // { sig: [bytes | null-for-wildcard], offset, ext, mime, desc }
  const SIGNATURES = [
    { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, ext: "png", mime: "image/png", desc: "PNG image" },
    { sig: [0xff, 0xd8, 0xff], offset: 0, ext: "jpg", mime: "image/jpeg", desc: "JPEG image" },
    { sig: [0x47, 0x49, 0x46, 0x38], offset: 0, ext: "gif", mime: "image/gif", desc: "GIF image" },
    { sig: [0x42, 0x4d], offset: 0, ext: "bmp", mime: "image/bmp", desc: "BMP image" },
    { sig: [0x25, 0x50, 0x44, 0x46], offset: 0, ext: "pdf", mime: "application/pdf", desc: "PDF document" },
    { sig: [0x50, 0x4b, 0x03, 0x04], offset: 0, ext: "zip", mime: "application/zip", desc: "ZIP archive (or docx/jar/apk)" },
    { sig: [0x1f, 0x8b], offset: 0, ext: "gz", mime: "application/gzip", desc: "GZIP archive" },
    { sig: [0x42, 0x5a, 0x68], offset: 0, ext: "bz2", mime: "application/x-bzip2", desc: "BZIP2 archive" },
    { sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], offset: 0, ext: "7z", mime: "application/x-7z-compressed", desc: "7-Zip archive" },
    { sig: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], offset: 0, ext: "rar", mime: "application/vnd.rar", desc: "RAR archive" },
    { sig: [0x7f, 0x45, 0x4c, 0x46], offset: 0, ext: "elf", mime: "application/x-elf", desc: "ELF executable" },
    { sig: [0x4d, 0x5a], offset: 0, ext: "exe", mime: "application/x-msdownload", desc: "Windows PE (MZ) executable" },
    { sig: [0xca, 0xfe, 0xba, 0xbe], offset: 0, ext: "class", mime: "application/java-vm", desc: "Java class / Mach-O fat binary" },
    { sig: [0xfe, 0xed, 0xfa, 0xce], offset: 0, ext: "macho", mime: "application/x-mach-binary", desc: "Mach-O executable (32-bit)" },
    { sig: [0xcf, 0xfa, 0xed, 0xfe], offset: 0, ext: "macho", mime: "application/x-mach-binary", desc: "Mach-O executable (64-bit LE)" },
    { sig: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00], offset: 0, ext: "sqlite", mime: "application/vnd.sqlite3", desc: "SQLite 3 database" },
    { sig: [0x49, 0x44, 0x33], offset: 0, ext: "mp3", mime: "audio/mpeg", desc: "MP3 audio (ID3)" },
    { sig: [0x52, 0x49, 0x46, 0x46], offset: 0, ext: "riff", mime: "audio/wav", desc: "RIFF container (WAV/AVI/WEBP)" },
    { sig: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, ext: "mkv", mime: "video/x-matroska", desc: "Matroska / WebM" },
    { sig: [0x00, 0x00, 0x01, 0x00], offset: 0, ext: "ico", mime: "image/x-icon", desc: "Windows icon" },
  ];
  function _matches(b, sig, offset) {
    if (b.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) { if (sig[i] !== null && b[offset + i] !== sig[i]) return false; }
    return true;
  }
  function detectFileType(input) {
    const b = toBytes(input);
    for (const s of SIGNATURES) { if (_matches(b, s.sig, s.offset)) return { ext: s.ext, mime: s.mime, desc: s.desc, matched: true }; }
    // Heuristic text detection: a NUL byte is a strong binary signal; otherwise
    // decode a sample as UTF-8 and call it text when almost every character is
    // printable (few replacement chars / control chars). This accepts non-ASCII
    // UTF-8 (accents, em-dashes, CJK, emoji) that an ASCII-only check would miss.
    const sample = b.subarray(0, 4096);
    if (b.length && !sample.includes(0)) {
      let text = "";
      try { text = new TextDecoder("utf-8", { fatal: false }).decode(sample); } catch (_) { text = ""; }
      const chars = [...text];
      if (chars.length) {
        const bad = chars.filter((ch) => { const c = ch.codePointAt(0); return c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13); }).length;
        if (bad / chars.length < 0.05) return { ext: "txt", mime: "text/plain", desc: "Plain text", matched: false };
      }
    }
    return { ext: null, mime: "application/octet-stream", desc: "Unknown / binary", matched: false };
  }

  return { toBytes, extractStrings, hexdump, shannonEntropy, entropyVerdict, detectFileType, SIGNATURES };
});
