const test = require("node:test");
const assert = require("node:assert/strict");
const { generateReplyClaude, echoableContent, claudeRequestOptions } = require("../utils/aiProvider");

const fakeClaude = (responses, requests) => ({
  beta: { messages: { create: async (req) => { requests.push(structuredClone(req)); return responses.shift(); } } },
});
const history = [{ role: "ai", text: "Hi!" }, { role: "customer", text: "Quote for a 3h deep clean" }];

test("Claude tool loop: runs the tool, sends the assistant turn back unchanged, returns the text", async () => {
  const requests = [];
  const firstTurn = [
    { type: "thinking", thinking: "", signature: "SIG" },
    { type: "tool_use", id: "tu1", name: "get_quote", input: { service: "Deep Clean", hours: 3 } },
  ];
  const client = fakeClaude([
    { stop_reason: "tool_use", content: firstTurn, model: "claude-opus-5" },
    { stop_reason: "end_turn", content: [{ type: "text", text: "That's £92.55." }], model: "claude-opus-5" },
  ], requests);
  const calls = [];
  const reply = await generateReplyClaude({
    system: "RULES", history, client,
    tools: [{ name: "get_quote", description: "d", parametersJsonSchema: { type: "object" } }],
    runTool: async (name, args) => { calls.push([name, args]); return { total: 92.55 }; },
  });
  assert.equal(reply, "That's £92.55.");
  assert.deepEqual(calls, [["get_quote", { service: "Deep Clean", hours: 3 }]]);
  const r0 = requests[0];
  assert.equal(r0.model, "claude-opus-5");
  assert.equal(r0.system, "RULES");
  assert.deepEqual(r0.messages, [{ role: "user", content: "Quote for a 3h deep clean" }]); // leading AI greeting dropped
  assert.deepEqual(r0.tools, [{ name: "get_quote", description: "d", input_schema: { type: "object" } }]);
  assert.deepEqual(r0.thinking, { type: "adaptive" });
  assert.deepEqual(r0.output_config, { effort: "low" });
  assert.equal(r0.fallbacks, "default");
  assert.deepEqual(r0.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(requests[1].messages[1], { role: "assistant", content: firstTurn });
  assert.deepEqual(requests[1].messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu1", content: JSON.stringify({ total: 92.55 }) }],
  });
});

test("tool errors are flagged is_error", async () => {
  const requests = [];
  const client = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "check_availability", input: {} }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Which date?" }] },
  ], requests);
  await generateReplyClaude({ system: "S", history, client, tools: [{ name: "check_availability" }], runTool: async () => ({ error: "Date must be…" }) });
  assert.equal(requests[1].messages[2].content[0].is_error, true);
});

test("a refusal returns null (the caller sends the hand-off message)", async () => {
  const client = fakeClaude([{ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }], []);
  assert.equal(await generateReplyClaude({ system: "S", history, client }), null);
});

test("after a mid-output fallback, internal blocks before the switch are not echoed", () => {
  const content = [
    { type: "text", text: "Let me check" },
    { type: "thinking", thinking: "" },
    { type: "tool_use", id: "x" },
    { type: "fallback", from: { model: "a" }, to: { model: "b" } },
    { type: "tool_use", id: "y" },
  ];
  assert.deepEqual(echoableContent(content), [{ type: "text", text: "Let me check" }, { type: "tool_use", id: "y" }]);
  assert.deepEqual(echoableContent([{ type: "text", text: "hi" }]), [{ type: "text", text: "hi" }]);
});

test("Haiku 4.5 gets no adaptive thinking, effort or fallbacks", () => {
  assert.deepEqual(claudeRequestOptions("claude-haiku-4-5"), {});
  assert.equal(claudeRequestOptions("claude-sonnet-5").fallbacks, undefined);
  assert.deepEqual(claudeRequestOptions("claude-sonnet-5").thinking, { type: "adaptive" });
});
