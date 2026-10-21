// Guards for lib/anthropic.js request-body assembly against malformed turns.
import { test, group, assert } from "./harness.mjs";
import A from "../lib/anthropic.js";

const { toAnthropicBody, mergeTurns } = A;

group("anthropic: a malformed turn does not crash body assembly", () => {
  test("mergeTurns skips null/undefined entries", () => {
    const out = mergeTurns([null, { role: "user", content: "hi" }, undefined, { role: "user", content: "there" }]);
    assert.equal(out.length, 1, "the two user turns merge into one");
    assert.equal(out[0].role, "user");
    assert.equal(out[0].content, "hi\n\nthere");
  });
  test("toAnthropicBody skips a null message rather than dereferencing it", () => {
    const body = toAnthropicBody({ messages: [null, { role: "user", content: "hello" }] });
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, "hello");
  });
});
