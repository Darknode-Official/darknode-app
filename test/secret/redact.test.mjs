// Secret redaction tests (DA-008) — shape rules, registered literals, deep walk.
import { test, group, assert } from "../harness.mjs";
import R from "../../lib/secret/redact.js";

const { redact, redactString, registerSecret, clearSecrets, containsSecret, MASK } = R;

group("redact: shape rules", () => {
  const cases = [
    ["anthropic", "key is sk-ant-api03-ABCdef0123456789ABCdef0123 end"],
    ["openai", "OPENAI=sk-proj-ABCdefGHIjkl0123456789MNOpqr here"],
    ["github classic", "token ghp_ABCdefGHIjkl0123456789MNOpqrSTUvwx12 ok"],
    ["github pat", "github_pat_11ABCDE0000aaaaaaaaaa_bbbbbbbbbbccccccc now"],
    ["google", "maps AIzaSyA1234567890abcdefghijklmnopqrstuv x"],
    ["slack", "hook xox"+"b-1234567890-ABCDEFGHijklmnop end"],
    ["aws id", "id AKIAIOSFODNN7EXAMPLE used"],
    ["jwt", "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w here"],
  ];
  for (const [label, input] of cases) {
    test("redacts " + label, () => {
      const out = redactString(input);
      assert.ok(out.indexOf(MASK) !== -1, label + " must be masked: " + out);
      assert.ok(!containsSecret(out), label + " output must be clean: " + out);
    });
  }

  test("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\nabc123\n-----END RSA PRIVATE KEY-----";
    const out = redactString("here it is:\n" + pem + "\nthanks");
    assert.ok(out.indexOf("PRIVATE KEY") === -1 || out.indexOf("[REDACTED PRIVATE KEY]") !== -1);
    assert.ok(out.indexOf("MIIBOgIBAAJBAKj") === -1, "key body must be gone");
  });

  test("redacts bearer and authorization headers", () => {
    assert.ok(redactString("Authorization: Bearer abc123def456ghi789").indexOf(MASK) !== -1);
    assert.ok(redactString("x-apikey: 0123456789abcdef0123").indexOf(MASK) !== -1);
  });

  test("redacts named secret assignments", () => {
    assert.ok(redactString('"api_key":"abcdef123456"').indexOf(MASK) !== -1);
    assert.ok(redactString("client_secret=supersecretvalue99").indexOf(MASK) !== -1);
  });
});

group("redact: precision (no over-redaction)", () => {
  test("ordinary prose is unchanged", () => {
    const s = "The quick brown fox scanned 10.0.0.5 on port 443 and found nothing.";
    assert.equal(redactString(s), s);
  });
  test("a short word near 'key' is not nuked", () => {
    const s = "turn the key in the lock";
    assert.equal(redactString(s), s);
  });
  test("is idempotent", () => {
    const once = redactString("token ghp_ABCdefGHIjkl0123456789MNOpqrSTUvwx12 x");
    assert.equal(redactString(once), once, "re-redacting must be stable");
  });
});

group("redact: registered literals", () => {
  test("an opaque registered value is scrubbed everywhere it appears", () => {
    clearSecrets();
    const weird = "ZZZ-not-a-known-shape-9f3a-plainish";
    registerSecret(weird);
    try {
      const out = redactString("in a log line: " + weird + " and again " + weird);
      assert.equal(out.indexOf(weird), -1, "literal must be gone");
      assert.ok(out.indexOf(MASK) !== -1);
    } finally { clearSecrets(); }
  });
  test("short values (<4 chars) are not registered (avoids nuking common strings)", () => {
    clearSecrets();
    registerSecret("ab");
    assert.equal(redactString("ab cd ab").indexOf(MASK), -1);
    clearSecrets();
  });
});

group("redact: deep object walk", () => {
  test("secret-named keys are masked regardless of value shape", () => {
    const out = redact({ user: "alice", token: "whatever-value-here", nested: { apiKey: "xyz12345", note: "fine" } });
    assert.equal(out.user, "alice");
    assert.equal(out.token, MASK);
    assert.equal(out.nested.apiKey, MASK);
    assert.equal(out.nested.note, "fine");
  });
  test("arrays and shape rules inside objects are handled", () => {
    const out = redact({ logs: ["Authorization: Bearer abcdefgh12345678", "nothing here"] });
    assert.ok(out.logs[0].indexOf(MASK) !== -1);
    assert.equal(out.logs[1], "nothing here");
  });
  test("cyclic structures do not hang", () => {
    const a = { name: "x" }; a.self = a;
    const out = redact(a);
    assert.equal(out.name, "x");
  });
});
