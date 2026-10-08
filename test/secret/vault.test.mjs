// Credential vault tests (DA-008) — encrypted at rest, fail-closed, cross-user isolation.
import { test, group, assert } from "../harness.mjs";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import V from "../../lib/secret/vault.js";

const { createVault } = V;

function freshCwd() { return mkdtempSync(join(tmpdir(), "dn-vault-")); }

// A fake OS-backed crypto: a per-"user" key XORs the bytes and prefixes a tag so
// a wrong key is detected (decrypt throws), modelling safeStorage's per-user key.
function fakeBackend(userKey, availableFlag) {
  const key = Buffer.from(String(userKey));
  const xor = (buf) => { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ key[i % key.length]; return o; };
  return {
    label: "fake:" + userKey,
    available: () => availableFlag !== false,
    encrypt: (s) => { const body = xor(Buffer.from(s, "utf8")); return Buffer.concat([Buffer.from("DN1" + userKey + ":"), body]); },
    decrypt: (b) => {
      const tag = "DN1" + userKey + ":";
      const head = b.slice(0, tag.length).toString();
      if (head !== tag) throw new Error("not encrypted by this user's key");
      return xor(b.slice(tag.length)).toString("utf8");
    },
  };
}

group("vault: encrypted at rest", () => {
  test("set/get round-trips through the backend", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("alice") });
      assert.ok(vault.set("s_anthropic_key", "sk-ant-SECRETvalue-123").ok);
      assert.equal(vault.get("s_anthropic_key"), "sk-ant-SECRETvalue-123");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("the on-disk file contains ciphertext, not the plaintext", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("alice") });
      vault.set("tok", "PLAINTEXT-SHOULD-NOT-APPEAR");
      const raw = readFileSync(vault.file, "utf8");
      assert.equal(raw.indexOf("PLAINTEXT-SHOULD-NOT-APPEAR"), -1, "plaintext must not be on disk");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("the secrets file is written mode 0600 (owner-only)", () => {
    if (platform() === "win32") return; // POSIX perms not meaningful on Windows
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("alice") });
      vault.set("tok", "x-value-1234");
      const m = statSync(vault.file).mode & 0o777;
      assert.equal(m, 0o600, "expected 0600, got 0" + m.toString(8));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("list() returns metadata only, never values", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("alice") });
      vault.set("a", "value-aaaa-1111"); vault.set("b", "value-bbbb-2222");
      const names = vault.list();
      assert.equal(names.length, 2);
      const json = JSON.stringify(names);
      assert.equal(json.indexOf("value-aaaa-1111"), -1);
      assert.ok(names.every((n) => n.protected === true && n.insecure === false));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("remove deletes an entry", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("alice") });
      vault.set("a", "value-aaaa-1111");
      assert.equal(vault.remove("a").removed, 1);
      assert.equal(vault.get("a"), null);
      assert.ok(!vault.has("a"));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

group("vault: cross-user isolation", () => {
  test("another OS user's backend cannot decrypt this user's secrets", () => {
    const cwd = freshCwd();
    try {
      // alice stores a secret...
      const alice = createVault({ cwd, backend: fakeBackend("alice") });
      alice.set("tok", "alice-only-secret-9999");
      // ...bob opens the SAME file with his own (different) OS key.
      const bob = createVault({ cwd, backend: fakeBackend("bob") });
      assert.equal(bob.get("tok"), null, "bob's key must NOT decrypt alice's secret");
      // sanity: alice still can
      assert.equal(alice.get("tok"), "alice-only-secret-9999");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

group("vault: fail-closed when OS encryption is unavailable", () => {
  test("set refuses rather than storing plaintext", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("x", false) }); // available=false
      const r = vault.set("tok", "secret-value-1234");
      assert.notOk(r.ok, "must refuse");
      assert.ok(/plaintext/i.test(r.error));
      assert.ok(!existsSync(vault.file), "nothing should be written");
      assert.deepEqual(vault.mode(), { ok: false, mode: "unavailable", backend: "none", insecure: false });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("explicit allowInsecure stores (flagged), get still works, mode reflects it", () => {
    const cwd = freshCwd();
    try {
      const vault = createVault({ cwd, backend: fakeBackend("x", false), allowInsecure: true });
      assert.ok(vault.set("tok", "secret-value-1234").ok);
      assert.equal(vault.get("tok"), "secret-value-1234");
      assert.equal(vault.mode().mode, "insecure-plaintext");
      assert.ok(vault.list()[0].insecure === true && vault.list()[0].protected === false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
