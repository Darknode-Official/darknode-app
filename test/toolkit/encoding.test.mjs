// Unit tests for lib/toolkit/encoding.js — known vectors + round-trips.
import { test, group, assert } from "../harness.mjs";
import E from "../../lib/toolkit/encoding.js";

const RT = ["", "A", "hello", "The quick brown fox", "héllo wörld — ünïcöde ✓", "🔒🛰️ mixed 日本語"];

group("encoding: base64", () => {
  test("known RFC 4648 vectors", () => {
    assert.equal(E.base64Encode("M"), "TQ==");
    assert.equal(E.base64Encode("Ma"), "TWE=");
    assert.equal(E.base64Encode("Man"), "TWFu");
    assert.equal(E.base64Encode("hello"), "aGVsbG8=");
  });
  test("decode inverts encode", () => {
    assert.equal(E.base64Decode("TWFu"), "Man");
    assert.equal(E.base64Decode("aGVsbG8="), "hello");
  });
  test("round-trips incl. unicode", () => {
    for (const s of RT) assert.equal(E.base64Decode(E.base64Encode(s)), s);
  });
  test("ignores whitespace in input", () => {
    assert.equal(E.base64Decode("aGVs bG8="), "hello");
  });
  test("rejects invalid", () => { assert.throws(() => E.base64DecodeToBytes("A")); });
  test("base64url has no +/= and round-trips", () => {
    const s = "subjects?_d=1>>>???";
    const u = E.base64UrlEncode(s);
    assert.notOk(/[+/=]/.test(u));
    assert.equal(E.base64UrlDecode(u), s);
  });
});

group("encoding: base32", () => {
  test("known RFC 4648 vectors", () => {
    assert.equal(E.base32Encode("f"), "MY======");
    assert.equal(E.base32Encode("fo"), "MZXQ====");
    assert.equal(E.base32Encode("foo"), "MZXW6===");
    assert.equal(E.base32Encode("foobar"), "MZXW6YTBOI======");
  });
  test("decode inverts encode", () => {
    assert.equal(E.base32Decode("MZXW6YTBOI======"), "foobar");
  });
  test("round-trips incl. unicode", () => {
    for (const s of RT) assert.equal(E.base32Decode(E.base32Encode(s)), s);
  });
});

group("encoding: base58", () => {
  test("known vector 'hello world'", () => {
    assert.equal(E.base58Encode("hello world"), "StV1DL6CwTryKyV");
    assert.equal(E.base58Decode("StV1DL6CwTryKyV"), "hello world");
  });
  test("round-trips incl. unicode", () => {
    for (const s of RT) assert.equal(E.base58Decode(E.base58Encode(s)), s);
  });
  test("rejects invalid alphabet (0OIl)", () => { assert.throws(() => E.base58Decode("0OIl")); });
});

group("encoding: hex / binary / decimal", () => {
  test("hex known + separators", () => {
    assert.equal(E.hexEncode("ABC"), "414243");
    assert.equal(E.hexEncode("ABC", " "), "41 42 43");
    assert.equal(E.hexDecode("41 42 43"), "ABC");
    assert.equal(E.hexDecode("0x414243"), "ABC");
  });
  test("hex rejects odd/invalid", () => {
    assert.throws(() => E.hexDecode("abc"));
    assert.throws(() => E.hexDecode("zz"));
  });
  test("binary known + round-trip", () => {
    assert.equal(E.toBinary("A"), "01000001");
    assert.equal(E.fromBinary("01000001 01000010"), "AB");
    for (const s of RT) assert.equal(E.fromBinary(E.toBinary(s)), s);
  });
  test("decimal bytes", () => { assert.equal(E.toDecimal("AB"), "65 66"); });
});

group("encoding: url / html", () => {
  test("url round-trip + plus-as-space", () => {
    assert.equal(E.urlEncode("a b&c=d"), "a%20b%26c%3Dd");
    assert.equal(E.urlDecode("a+b%26c"), "a b&c");
  });
  test("html escape/unescape", () => {
    assert.equal(E.htmlEncode(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    assert.equal(E.htmlDecode("&lt;a&gt;&amp;&#39;&#x27;&quot;"), "<a>&''\"");
  });
});

group("encoding: rot / morse", () => {
  test("rot13 is its own inverse", () => {
    assert.equal(E.rot13("Hello, World!"), "Uryyb, Jbeyq!");
    assert.equal(E.rot13(E.rot13("Hello")), "Hello");
  });
  test("rotN wraps and rot47 round-trips", () => {
    assert.equal(E.rotN(1, "abcXYZ"), "bcdYZA");
    assert.equal(E.rot47(E.rot47("Hello 42!")), "Hello 42!");
  });
  test("morse encode/decode", () => {
    assert.equal(E.toMorse("SOS"), "... --- ...");
    assert.equal(E.toMorse("HI THERE"), ".... .. / - .... . .-. .");
    assert.equal(E.fromMorse("... --- ..."), "SOS");
    assert.equal(E.fromMorse(".... .. / - .... . .-. ."), "HI THERE");
  });
});
