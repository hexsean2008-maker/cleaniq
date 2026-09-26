// Sends a conversation to the configured AI provider and returns the reply text.
// Provider is chosen in .env so it can be switched without code changes:
//   AI_PROVIDER=gemini      + GEMINI_API_KEY=...
//   AI_PROVIDER=anthropic   + ANTHROPIC_API_KEY=...   (Claude)
//   AI_MODEL=...            (optional; defaults below)
//   AI_EFFORT=low           (Claude only; low | medium | high — lower is faster and cheaper)
//   AI_MODEL=gemini-3.8-flash            (optional)
//   AI_FALLBACK_MODEL=gemini-3.7-flash,gemini-3.5-flash   (optional; tried in order when the main model is busy)
//   AI_THINKING_LEVEL=LOW                (optional; LOW | MEDIUM | HIGH — lower is faster)
const PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", anthropic: "claude-opus-5" };
const DEFAULT_FALLBACK_MODELS = { gemini: "gemini-3.7-flash,gemini-3.5-flash" };
const TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1500, 4000];

// Overloaded / rate-limited / server errors and timeouts are worth retrying; bad requests are not.
const isRetryable = (err) => err?.timeout || [429, 500, 502, 503, 504].includes(err?.status);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Our roles → Gemini roles. Gemini needs the first turn to be "user" and works best with
// alternating turns, so consecutive turns from the same side are merged.
function toGeminiContents(history) {
  const contents = [];
  for (const msg of history) {
    const text = (msg.text || "").trim();
    if (!text) continue;
    const role = msg.role === "customer" ? "user" : "model"; // ai + staff replies are "our" side
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role !== "user") contents.shift();
  return contents;
}

let geminiClient = null;
function getGemini() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in server/.env");
  if (!geminiClient) {
    const { GoogleGenAI } = require("@google/genai");
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`AI provider timed out after ${ms / 1000}s`), { timeout: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const MAX_TOOL_ROUNDS = 5;

// One model call with retries. Tries `models` in order (main model, retries, then fallback).
async function callModel({ client, models, contents, system, tools, retryDelays }) {
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await withTimeout(
        (client || getGemini()).models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            maxOutputTokens: 2048,
            temperature: 0.4,
            // Receptionist replies are short lookups; low thinking keeps them fast (default is medium).
            thinkingConfig: { thinkingLevel: (process.env.AI_THINKING_LEVEL || "LOW").toUpperCase() },
            ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}),
          },
        }),
        TIMEOUT_MS,
      );
      return { response, model };
    } catch (err) {
      if (!isRetryable(err) || i === models.length - 1) throw err;
      // 429 = this model's quota is used up: retrying it only burns more quota, so move to the next model.
      let next = i + 1;
      if (err.status === 429) while (next < models.length - 1 && models[next] === model) next++;
      if (models[next] === model && err.status === 429) throw err;
      console.warn(`[ai] ${model} failed (${err.status || "timeout"}); retrying${models[next] !== model ? ` with ${models[next]}` : ""}`);
      if (models[next] === model && i < retryDelays.length) await sleep(retryDelays[i]);
      i = next - 1;
    }
  }
  throw new Error("No AI model available");
}

/**
 * @param {object} args
 * @param {string} args.system   instructions from aiBrain.getInstructions()
 * @param {{role: "customer"|"ai"|"staff", text: string}[]} args.history  oldest first, ending with the customer's message
 * @param {object[]} [args.tools]   function declarations the model may call (see aiTools.js)
 * @param {(name: string, args: object) => Promise<object>} [args.runTool]  executes a tool call
 * @param {object} [args.client] injected client for tests
 * @param {number[]} [args.retryDelays] override retry waits (tests)
 * @returns {Promise<string|null>} reply text, or null if the provider returned nothing usable
 * Retries the main model on temporary errors, then tries the fallback model once.
 */
async function generateReply({ system, history, tools, runTool, client, retryDelays = RETRY_DELAYS_MS }) {
  if (PROVIDER === "anthropic") return generateReplyClaude({ system, history, tools, runTool, client });
  if (PROVIDER !== "gemini") {
    throw new Error(`AI_PROVIDER "${PROVIDER}" is not supported (supported: gemini, anthropic)`);
  }
  const contents = toGeminiContents(history);
  if (!contents.length) return null;

  const primary = process.env.AI_MODEL || DEFAULT_MODELS.gemini;
  const fallbacks = (process.env.AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODELS.gemini)
    .split(",").map((m) => m.trim()).filter((m) => m && m !== primary);
  let models = [...retryDelays.map(() => primary), primary, ...fallbacks];

  const started = Date.now();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { response, model } = await callModel({ client, models, contents, system, tools, retryDelays });
    if (round === 0 && model !== primary) console.warn(`[ai] answered by fallback model ${model}`);
    // Stay on the model that answered: its thought signatures only make sense to itself.
    models = [...retryDelays.map(() => model), model];

    const calls = tools?.length && runTool ? response.functionCalls || [] : [];
    if (!calls.length) {
      const text = (response.text || "").trim();
      if (!text) {
        const reason = response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason || "unknown";
        console.warn(`[ai] empty reply from ${PROVIDER} (reason: ${reason})`);
        return null;
      }
      console.log(`[ai] ${PROVIDER} replied in ${Date.now() - started}ms${round ? ` after ${round} tool round(s)` : ""}`);
      return text;
    }

    // Send the model's turn back unchanged (it carries Gemini 3 thought signatures), then the results.
    contents.push(response.candidates[0].content);
    const results = await Promise.all(
      calls.map(async (call) => {
        const result = await runTool(call.name, call.args || {});
        console.log(`[ai] tool ${call.name} → ${result?.error ? `error: ${result.error}` : "ok"}`);
        return result;
      }),
    );
    contents.push({
      role: "user",
      parts: calls.map((call, i) => ({
        functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: results[i] || {} },
      })),
    });
  }
  console.warn(`[ai] gave up after ${MAX_TOOL_ROUNDS} tool rounds`);
  return null;
}

// ── Claude (Anthropic) ────────────────────────────────────────────────────────────────
let anthropicClient = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in server/.env");
  if (!anthropicClient) {
    const sdk = require("@anthropic-ai/sdk");
    const Anthropic = sdk.default || sdk;
    // The SDK retries 408/409/429/5xx and connection errors itself.
    anthropicClient = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 2 });
  }
  return anthropicClient;
}

// Same mapping as Gemini: first turn must be the customer's, same-side turns merged.
function toClaudeMessages(history) {
  return toGeminiContents(history).map((c) => ({
    role: c.role === "user" ? "user" : "assistant",
    content: c.parts[0].text,
  }));
}

// After a mid-output server-side fallback, model-internal blocks before the switch point must
// not be sent back; text before it and everything after it are kept.
function echoableContent(content) {
  const cut = content.map((b) => b.type).lastIndexOf("fallback");
  if (cut < 0) return content;
  return [...content.slice(0, cut).filter((b) => b.type === "text"), ...content.slice(cut + 1)];
}

// Request options differ by model: Claude Haiku 4.5 takes no adaptive thinking/effort/fallbacks.
function claudeRequestOptions(model) {
  if (model.startsWith("claude-haiku-4-5")) return {};
  const options = {
    thinking: { type: "adaptive" },
    output_config: { effort: (process.env.AI_EFFORT || "low").toLowerCase() },
  };
  // If the model declines a message, Anthropic re-runs it on its recommended fallback model.
  if (["claude-opus-5", "claude-fable-5-1"].includes(model)) {
    Object.assign(options, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  }
  return options;
}

async function generateReplyClaude({ system, history, tools, runTool, client }) {
  const messages = toClaudeMessages(history);
  if (!messages.length) return null;
  const model = process.env.AI_MODEL || DEFAULT_MODELS.anthropic;
  const claudeTools = tools?.length && runTool
    ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parametersJsonSchema }))
    : null;

  const started = Date.now();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await (client || getAnthropic()).beta.messages.create({
      model,
      max_tokens: 8000,
      system,
      messages,
      ...(claudeTools ? { tools: claudeTools } : {}),
      ...claudeRequestOptions(model),
    });

    if (response.stop_reason === "refusal") {
      console.warn(`[ai] claude declined (${response.stop_details?.category || "no category"})`);
      return null;
    }
    const toolUses = claudeTools ? response.content.filter((b) => b.type === "tool_use") : [];
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text) {
        console.warn(`[ai] empty reply from claude (stop: ${response.stop_reason})`);
        return null;
      }
      if (response.stop_reason === "max_tokens") console.warn("[ai] claude reply hit max_tokens");
      console.log(`[ai] claude (${response.model}) replied in ${Date.now() - started}ms${round ? ` after ${round} tool round(s)` : ""}`);
      return text;
    }

    messages.push({ role: "assistant", content: echoableContent(response.content) });
    // All results for this turn go back together in one user message.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const result = (await runTool(block.name, block.input || {})) || {};
        console.log(`[ai] tool ${block.name} → ${result.error ? `error: ${result.error}` : "ok"}`);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
          ...(result.error ? { is_error: true } : {}),
        };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  console.warn(`[ai] gave up after ${MAX_TOOL_ROUNDS} tool rounds`);
  return null;
}

module.exports = { generateReply, generateReplyClaude, toGeminiContents, echoableContent, claudeRequestOptions, PROVIDER };
