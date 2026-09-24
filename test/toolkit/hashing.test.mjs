// Unit tests for lib/toolkit/hashing.js — known vectors.
import { test, group, assert } from "../harness.mjs";
import H from "../../lib/toolkit/hashing.js";

group("hashing: crc32", () => {
  test("known vectors", () => {
    assert.equal(H.crc32(""), 0);
    assert.equal(H.crc32("123456789") >>> 0, 0xcbf43926);
    assert.equal(H.crc32("The quick brown fox jumps over the lazy dog") >>> 0, 0x414fa339);
    assert.equal(H.crc32Hex("123456789"), "cbf43926");
  });
});

group("hashing: non-crypto checksums", () => {
  test("fnv1a-32 offset basis for empty; deterministic", () => {
    assert.equal(H.fnv1a(""), 0x811c9dc5);
    assert.equal(H.fnv1a("a") >>> 0, 0xe40c292c);
    assert.equal(H.fnv1a("hello"), H.fnv1a("hello"));
  });
  test("adler32 known vectors", () => {
    assert.equal(H.adler32(""), 1);
    assert.equal(H.adler32("Wikipedia") >>> 0, 0x11e60398);
  });
  test("djb2 / sdbm are deterministic 32-bit", () => {
    assert.equal(H.djb2("abc"), H.djb2("abc"));
    assert.ok(H.djb2("abc") >= 0 && H.djb2("abc") <= 0xffffffff);
    assert.notEqual(H.djb2("abc"), H.sdbm("abc"));
  });
});

group("hashing: luhn", () => {
  test("validate known numbers", () => {
    assert.ok(H.luhnValid("79927398713"));
    assert.notOk(H.luhnValid("79927398710"));
    assert.ok(H.luhnValid("4539 1488 0343 6467")); // spaced test Visa
  });
  test("check digit + generate", () => {
    assert.equal(H.luhnCheckDigit("7992739871"), 3);
    assert.equal(H.luhnGenerate("7992739871"), "79927398713");
    assert.ok(H.luhnValid(H.luhnGenerate("123456789")));
  });
  test("non-digit rejected", () => {
    assert.notOk(H.luhnValid("12a4"));
    assert.equal(H.luhnCheckDigit("nope"), null);
  });
});

group("hashing: crypto digests (Node)", () => {
  test("crypto available in test env", () => { assert.ok(H.hasNodeCrypto); });
  test("md5 known vectors", () => {
    assert.equal(H.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(H.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  });
  test("sha1 / sha256 / sha512 known vectors", () => {
    assert.equal(H.sha1("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert.equal(H.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(H.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(H.sha512("abc").slice(0, 16), "ddaf35a193617aba");
  });
  test("hash() normalizes algo name", () => {
    assert.equal(H.hash("SHA-256", "abc"), H.sha256("abc"));
  });
});
