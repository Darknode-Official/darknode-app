// Unit tests for lib/toolkit/forensics.js.
import { test, group, assert } from "../harness.mjs";
import F from "../../lib/toolkit/forensics.js";

group("forensics: extractStrings", () => {
  test("finds printable runs with offsets, honors min", () => {
    const buf = Uint8Array.from([0, 0, 72, 101, 108, 108, 111, 0, 1, 2, 65, 66]); // "Hello" then "AB"
    const s4 = F.extractStrings(buf, 4);
    assert.equal(s4.length, 1);
    assert.equal(s4[0].text, "Hello");
    assert.equal(s4[0].offset, 2);
    const s2 = F.extractStrings(buf, 2);
    assert.equal(s2.length, 2);
    assert.equal(s2[1].text, "AB");
    assert.equal(s2[1].offset, 10);
  });
  test("string input works", () => {
    assert.equal(F.extractStrings("password123", 4)[0].text, "password123");
  });
});

group("forensics: hexdump", () => {
  test("classic layout for short input", () => {
    const d = F.hexdump("ABC");
    const first = d.split("\n")[0];
    assert.ok(first.startsWith("00000000"));
    assert.ok(first.includes("41 42 43"));
    assert.ok(first.includes("|ABC|"));
  });
  test("non-printables shown as dots; empty -> empty", () => {
    const d = F.hexdump(Uint8Array.from([0x00, 0x41, 0xff]));
    assert.ok(/\|\.A\.\|/.test(d));
    assert.equal(F.hexdump(""), "");
  });
});

group("forensics: entropy", () => {
  test("bounds: repeated=0, two-symbol=1, uniform 256 -> 8", () => {
    assert.equal(F.shannonEntropy("aaaaaaaa"), 0);
    assert.close(F.shannonEntropy("abab"), 1, 1e-9);
    const all = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
    assert.close(F.shannonEntropy(all), 8, 1e-9);
  });
  test("verdicts", () => {
    assert.ok(/zero/.test(F.entropyVerdict("aaaa").verdict));
    assert.ok(/very high/.test(F.entropyVerdict(7.9).verdict));
    assert.ok(/moderate/.test(F.entropyVerdict(5.0).verdict));
  });
});

group("forensics: detectFileType", () => {
  test("magic bytes", () => {
    assert.equal(F.detectFileType([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).ext, "png");
    assert.equal(F.detectFileType([0xff, 0xd8, 0xff, 0xe0]).ext, "jpg");
    assert.equal(F.detectFileType([0x25, 0x50, 0x44, 0x46, 0x2d]).ext, "pdf");
    assert.equal(F.detectFileType([0x7f, 0x45, 0x4c, 0x46, 0x02]).ext, "elf");
    assert.equal(F.detectFileType([0x50, 0x4b, 0x03, 0x04]).ext, "zip");
    assert.equal(F.detectFileType([0x4d, 0x5a, 0x90, 0x00]).ext, "exe");
  });
  test("text vs unknown binary", () => {
    assert.equal(F.detectFileType("hello world\n").ext, "txt");
    assert.equal(F.detectFileType("Darknode — desktop app · ünïcödé ✓\n").ext, "txt"); // UTF-8 text
    assert.equal(F.detectFileType([0x00, 0x01, 0x02, 0xfe, 0xff]).mime, "application/octet-stream"); // NUL -> binary
    assert.equal(F.detectFileType([0xde, 0xad, 0xbe, 0xef, 0x01, 0x7f, 0x80, 0x99]).ext, null); // invalid utf-8 binary
  });
});
