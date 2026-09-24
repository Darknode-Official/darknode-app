// Unit tests for lib/toolkit/crypto.js — standard cipher vectors + round-trips.
import { test, group, assert } from "../harness.mjs";
import C from "../../lib/toolkit/crypto.js";

group("crypto: xor", () => {
  test("hex round-trip incl. unicode", () => {
    for (const s of ["", "secret", "héllo 🔐", "The quick brown fox"]) {
      assert.equal(C.xorFromHex("k3y", C.xorHex("k3y", s)), s);
    }
  });
  test("known single-byte xor", () => {
    // 'A'(0x41) ^ 0x20 = 0x61 = 'a'
    assert.equal(C.xorHex(" ", "A"), "61");
  });
  test("rejects bad hex", () => { assert.throws(() => C.xorFromHex("k", "xyz")); });
});

group("crypto: caesar / atbash", () => {
  test("caesar shift + inverse", () => {
    assert.equal(C.caesar(3, "abcXYZ"), "defABC");
    assert.equal(C.caesarDecrypt(3, C.caesar(3, "Hello, World!")), "Hello, World!");
  });
  test("atbash is self-inverse", () => {
    assert.equal(C.atbash("abc"), "zyx");
    assert.equal(C.atbash(C.atbash("Attack at Dawn")), "Attack at Dawn");
  });
});

group("crypto: vigenère", () => {
  test("classic LEMON vector", () => {
    assert.equal(C.vigenereEncrypt("LEMON", "ATTACKATDAWN"), "LXFOPVEFRNHR");
    assert.equal(C.vigenereDecrypt("LEMON", "LXFOPVEFRNHR"), "ATTACKATDAWN");
  });
  test("preserves case + non-letters, key advances only on letters", () => {
    const pt = "Attack at Dawn!";
    assert.equal(C.vigenereDecrypt("LEMON", C.vigenereEncrypt("LEMON", pt)), pt);
  });
  test("empty key rejected", () => { assert.throws(() => C.vigenereEncrypt("123", "abc")); });
});

group("crypto: a1z26", () => {
  test("encode/decode", () => {
    assert.equal(C.a1z26Encode("abc"), "1 2 3");
    assert.equal(C.a1z26Decode("8 5 12 12 15"), "hello");
  });
  test("out-of-range rejected", () => { assert.throws(() => C.a1z26Decode("27")); });
});

group("crypto: rail fence", () => {
  test("classic 3-rail vector", () => {
    const pt = "WEAREDISCOVEREDFLEEATONCE";
    assert.equal(C.railFenceEncrypt(3, pt), "WECRLTEERDSOEEFEAOCAIVDEN");
    assert.equal(C.railFenceDecrypt(3, "WECRLTEERDSOEEFEAOCAIVDEN"), pt);
  });
  test("round-trips for several rails", () => {
    const pt = "DEFENDTHEEASTWALLATDAWN";
    for (const r of [2, 3, 4, 5]) assert.equal(C.railFenceDecrypt(r, C.railFenceEncrypt(r, pt)), pt);
  });
  test("needs >= 2 rails", () => { assert.throws(() => C.railFenceEncrypt(1, "abc")); });
});
