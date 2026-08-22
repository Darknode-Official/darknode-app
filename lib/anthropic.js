"use strict";
// Translate the app's Ollama-style chat request into an Anthropic Messages API
// request, and parse Anthropic's streaming SSE deltas into plain text. Pure +
// unit-tested; the Electron main process performs the actual HTTPS streaming.

const DEFAULT_MODEL = "claude-sonnet-4-5";

function textOf(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOf).join("");
  if (typeof c === "object") return c.text != null ? c.text : JSON.stringify(c);
  return String(c);
}

// Map an app/model name to an Anthropic model id (real claude-* ids pass through;
// local model names fall back to the default cloud model).
function mapModel(m) {
  m = String(m || "").toLowerCase();
  if (/^claude-/.test(m)) return m;
  if (/opus/.test(m)) return "claude-opus-4-1";
  if (/haiku/.test(m)) return "claude-haiku-4-5";
  if (/sonnet/.test(m)) return "claude-sonnet-4-5";
  return DEFAULT_MODEL; // local model names (llama/qwen/…) or blank -> default
}

// Anthropic needs strictly alternating roles beginning with a user turn; merge
// consecutive same-role messages and drop any leading assistant turns.
function mergeTurns(conv) {
  const out = [];
  for (const m of conv) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// toAnthropicBody({ model, messages, format, options, max_tokens }) -> request body.
function toAnthropicBody(b) {
  b = b || {};
  let system = "";
  const conv = [];
  for (const m of (b.messages || [])) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + textOf(m.content); continue; }
    conv.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) });
  }
  // Ollama structured output (format = JSON schema) -> instruct Claude to emit ONLY
  // that JSON, since the app's agent loop parses a JSON object from the reply.
  if (b.format && typeof b.format === "object") {
    system += (system ? "\n\n" : "") + "You MUST reply with ONLY a single valid JSON object conforming to this JSON schema — no prose, no markdown fences:\n" + JSON.stringify(b.format);
  }
  const merged = mergeTurns(conv);
  const out = {
    model: mapModel(b.model),
    max_tokens: (b.options && b.options.num_predict) || b.max_tokens || 4096,
    messages: merged.length ? merged : [{ role: "user", content: "continue" }],
  };
  if (system) out.system = system;
  if (b.options && typeof b.options.temperature === "number") out.temperature = b.options.temperature;
  return out;
}

// anthropicDelta(evtObj) -> the text delta for a parsed SSE data object ("" if none).
function anthropicDelta(o) {
  if (o && o.type === "content_block_delta" && o.delta && o.delta.type === "text_delta") return o.delta.text || "";
  return "";
}

// usageOf(evtObj) -> { inTok, outTok } when a message_start / message_delta carries usage.
function usageOf(o) {
  if (!o) return null;
  if (o.type === "message_start" && o.message && o.message.usage) return { inTok: o.message.usage.input_tokens || 0, outTok: o.message.usage.output_tokens || 0 };
  if (o.type === "message_delta" && o.usage) return { inTok: 0, outTok: o.usage.output_tokens || 0 };
  return null;
}

module.exports = { DEFAULT_MODEL, toAnthropicBody, anthropicDelta, usageOf, mapModel, mergeTurns, textOf };
