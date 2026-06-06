import { ARENA_MODELS_TEST_ENDPOINT } from "./config.js";

function numberParam(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function integerParam(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value;
}

function objectParam(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function booleanParam(value) {
  if (typeof value !== "boolean") return undefined;
  return value;
}

function stringParam(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeThinkingConfig(value) {
  const config = { ...objectParam(value) };
  const thinkingBudget = firstDefined(
    integerParam(config.thinkingBudget),
    integerParam(config.thinking_budget),
  );
  const includeThoughts = firstDefined(
    booleanParam(config.includeThoughts),
    booleanParam(config.include_thoughts),
  );
  const thinkingLevel = firstDefined(
    stringParam(config.thinkingLevel),
    stringParam(config.thinking_level),
  );

  delete config.thinking_budget;
  delete config.include_thoughts;
  delete config.thinking_level;
  if (thinkingBudget !== undefined) config.thinkingBudget = thinkingBudget;
  if (includeThoughts !== undefined) config.includeThoughts = includeThoughts;
  if (thinkingLevel !== undefined) config.thinkingLevel = thinkingLevel;
  return config;
}

function buildThinkingConfig(request) {
  const reasoning = objectParam(request.reasoning);
  const googleThinking = objectParam(request.google_thinking || request.googleThinking);

  const thinkingBudget = firstDefined(
    integerParam(googleThinking.thinking_budget),
    integerParam(googleThinking.thinkingBudget),
    integerParam(googleThinking.budget),
    integerParam(reasoning.thinking_budget),
    integerParam(reasoning.thinkingBudget),
    integerParam(request.thinking_budget),
    integerParam(request.thinkingBudget),
  );
  const includeThoughts = firstDefined(
    booleanParam(googleThinking.include_thoughts),
    booleanParam(googleThinking.includeThoughts),
    booleanParam(reasoning.include_thoughts),
    booleanParam(reasoning.includeThoughts),
    booleanParam(request.include_thoughts),
    booleanParam(request.includeThoughts),
  );
  const thinkingLevel = firstDefined(
    stringParam(googleThinking.thinking_level),
    stringParam(googleThinking.thinkingLevel),
    stringParam(googleThinking.level),
    stringParam(reasoning.thinking_level),
    stringParam(reasoning.thinkingLevel),
    stringParam(request.thinking_level),
    stringParam(request.thinkingLevel),
  );

  const thinkingConfig = {
    ...normalizeThinkingConfig(googleThinking.thinking_config || googleThinking.thinkingConfig),
    ...normalizeThinkingConfig(reasoning.thinking_config || reasoning.thinkingConfig),
    ...normalizeThinkingConfig(request.thinking_config || request.thinkingConfig),
  };
  if (thinkingBudget !== undefined) thinkingConfig.thinkingBudget = thinkingBudget;
  if (includeThoughts !== undefined) thinkingConfig.includeThoughts = includeThoughts;
  if (thinkingLevel !== undefined) thinkingConfig.thinkingLevel = thinkingLevel;

  return thinkingConfig;
}

export function buildArenaBody({ model, prompt, request }) {
  const inferenceSettings = {
    ...objectParam(model.modelsTestDefaultInferenceSettings),
    ...objectParam(request.arena_inference_settings || request.inference_settings),
  };

  const maxTokens = integerParam(request.max_tokens ?? request.max_completion_tokens);
  if (maxTokens !== undefined && maxTokens >= 16) inferenceSettings.maxTokens = maxTokens;

  const reasoningEffort =
    typeof request.reasoning_effort === "string"
      ? request.reasoning_effort
      : typeof request.reasoning?.effort === "string"
        ? request.reasoning.effort
        : undefined;
  if (reasoningEffort !== undefined) inferenceSettings.reasoningEffort = reasoningEffort;

  const temperature = numberParam(request.temperature);
  if (temperature !== undefined) inferenceSettings.temperature = temperature;

  const topP = numberParam(request.top_p);
  if (topP !== undefined) inferenceSettings.topP = topP;

  const thinkingConfig = buildThinkingConfig(request);
  if (Object.keys(thinkingConfig).length > 0) {
    inferenceSettings.thinkingConfig = {
      ...objectParam(inferenceSettings.thinkingConfig),
      ...thinkingConfig,
    };
  }

  const body = {
    prompt,
    apiModelName: model.modelsTestApiModelName || model.apiModelName,
    provider: model.modelsTestProvider || model.provider,
    capabilities: model.capabilities,
    ...objectParam(request.arena_extra_body),
  };

  if (Object.keys(inferenceSettings).length > 0) body.inferenceSettings = inferenceSettings;
  return body;
}

export function isAbortError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    message.includes("client_aborted") ||
    message.includes("client_closed") ||
    message.includes("operation was aborted")
  );
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "client_aborted");
  error.name = "AbortError";
  throw error;
}

export async function postArenaModelsTest(body, { signal } = {}) {
  throwIfAborted(signal);
  const res = await fetch(ARENA_MODELS_TEST_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json,text/event-stream,text/plain,*/*",
      origin: "https://arena.ai",
      referer: "https://arena.ai/",
      "user-agent": "LMArenaBridge/0.1",
    },
    body: JSON.stringify(body),
  });
  return res;
}

function errorText(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function eventText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(eventText).join("");
  if (!value || typeof value !== "object") return "";
  for (const key of [
    "text",
    "delta",
    "content",
    "textDelta",
    "reasoning",
    "reasoningText",
    "reasoningDelta",
    "argsTextDelta",
    "data",
  ]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

export function isTimeoutLikeError(error) {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("operation was aborted") ||
    text.includes("aborterror")
  );
}

export const CONTINUATION_MARKER = "<<<LMARENA_CONTINUE>>>";

export function removeContinuationMarkers(content) {
  return String(content || "").replaceAll(CONTINUATION_MARKER, "").replace(/[ \t]+\n/g, "\n");
}

export function mergeUsage(total, next) {
  if (!next) return total || null;
  const current = total || {};
  const promptTokens = (current.promptTokens ?? 0) + (next.promptTokens ?? 0);
  const completionTokens = (current.completionTokens ?? 0) + (next.completionTokens ?? 0);
  const totalTokens =
    (current.totalTokens ?? 0) ||
    (current.promptTokens ?? 0) + (current.completionTokens ?? 0) ||
    0;
  const nextTotal =
    next.totalTokens ?? (next.promptTokens ?? 0) + (next.completionTokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens + nextTotal,
  };
}

export function stripOverlap(previous, next, maxOverlap = 2000) {
  if (!previous || !next) return next || "";
  const haystack = previous.slice(-maxOverlap);
  const limit = Math.min(haystack.length, next.length);
  const minOverlap = limit >= 16 ? 16 : Math.min(4, limit);
  for (let size = limit; size >= minOverlap; size -= 1) {
    if (haystack.endsWith(next.slice(0, size))) return next.slice(size);
  }
  return next;
}

function trimTrailingClosers(text) {
  return text.trim().replace(/[\s"'`)\]}>\u300d\u300f\u3011\uff09\u300b\u201d\u2019]+$/u, "");
}

function hasUnclosedCodeFence(text) {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

function hasUnclosedBrackets(text) {
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
    ["\u3010", "\u3011"],
    ["\uff08", "\uff09"],
    ["\u300a", "\u300b"],
  ];
  for (const [open, close] of pairs) {
    const opens = [...text].filter((ch) => ch === open).length;
    const closes = [...text].filter((ch) => ch === close).length;
    if (opens > closes) return true;
  }
  return false;
}

export function looksLikeIncompleteTail(content) {
  const text = String(content || "").trim();
  if (text.length < 24) return false;

  if (hasUnclosedCodeFence(text)) return true;
  if (hasUnclosedBrackets(text)) return true;
  if (/<[A-Za-z][^>\n]*$/u.test(text)) return true;

  const tail = trimTrailingClosers(text).slice(-120);
  if (!tail) return false;
  if (/[.!?\u3002\uff01\uff1f\u2026]$/u.test(tail)) return false;
  if (/(?:<\/(?:html|body|script|style|div|section|article|main|svg|canvas)>|```|[;}\]])$/iu.test(tail)) {
    return false;
  }

  if (/[,，、:：;；(\[\{\u300c\u300e\u3010\uff08\u300a]$/u.test(tail)) return true;

  const chineseDangling =
    /(直接|然后|接着|随后|于是|并|以及|或者|还是|但是|然而|因为|所以|如果|当|在|向|对|从|把|被|将|让|使|与|和|及|而|却|便|才|正要|准备|开始|继续|伸出|拿起|低声|轻轻|缓缓|突然|已经|没有|不是|就是|成为|进入|靠近|看着|说道|问道|感到|发现|意识到|为了|通过|使用|实现|包括|例如|如下|分别|其中|这个|那个)$/u;
  if (chineseDangling.test(tail)) return true;

  const englishDangling =
    /\b(?:the|a|an|to|of|for|with|and|or|but|because|if|when|while|then|by|from|into|onto|as|is|are|was|were|be|being|been|this|that|these|those)$/iu;
  return englishDangling.test(tail);
}

export function shouldContinueArenaResponse(parsed) {
  if (!parsed) return null;
  if (parsed.continuationMarkerSeen) return "assistant_requested_continuation_marker";
  if (isTimeoutLikeError(parsed.error)) return "timeout";
  if (parsed.finishReason === "length") return "finish_reason_length";
  if (parsed.finishStepSeen && !parsed.finishMessageSeen) return "finish_step_without_message_done";
  if (parsed.reasoningEventCount > 0 && !parsed.content?.trim()) {
    return "reasoning_only_no_visible_content";
  }
  if (!parsed.terminalEventSeen && parsed.content) return "stream_closed_without_terminal_event";
  if (!parsed.terminalEventSeen && !parsed.error && parsed.events?.length > 0) {
    return "stream_closed_without_terminal_event";
  }
  if (!parsed.error && parsed.content && looksLikeIncompleteTail(parsed.content)) {
    return "semantic_incomplete_tail";
  }
  return null;
}

export function buildContinuationPrompt({ originalPrompt, accumulatedContent, reason, contextChars }) {
  if (!accumulatedContent) {
    const reasoningOnly = String(reason || "").includes("reasoning");
    return [
      "Latency-critical generation mode.",
      reasoningOnly
        ? "The prior attempt spent time in hidden reasoning and emitted no visible answer."
        : "The prior attempt ended before visible content arrived.",
      "The scoring target is earliest visible final-answer bytes, not hidden reasoning.",
      "Before the first token, do at most one private routing decision.",
      `Reason: ${reason}.`,
      "",
      "Output contract:",
      "Do not think step by step. Do not outline. Do not explain.",
      "Start now with the actual answer or artifact and keep writing it.",
      "Preserve the requested language, format, voice, and role state.",
      `If the answer is not fully complete when this call ends, append ${CONTINUATION_MARKER} as the final line. The bridge removes it.`,
      "If the answer is fully complete, do not append the marker.",
      "",
      "Original request:",
      "<<<REQUEST>>>",
      originalPrompt,
      "<<<END_REQUEST>>>",
    ].join("\n");
  }

  return [
    "Latency-critical continuation mode.",
    "The scoring target is earliest visible continuation bytes, not hidden reasoning.",
    "Before the first token, do at most one private routing decision.",
    `Reason: ${reason}.`,
    "",
    "Continue the prior assistant answer from exactly after the delivered context below.",
    "",
    "Complete delivered answer so far:",
    "<<<DELIVERED_CONTEXT>>>",
    accumulatedContent,
    "<<<END_DELIVERED_CONTEXT>>>",
    "",
    "Output contract:",
    "Do not think step by step. Do not outline. Do not explain.",
    "First visible character must be the next character after the delivered context.",
    "Do not repeat the delivered context, restart the answer, summarize, or add a transition sentence.",
    "Preserve the same language, formatting, code style, voice, character, and roleplay state.",
    "If continuing code, keep writing code; do not reopen a markdown fence unless the delivered context is inside one.",
    `If the answer is still incomplete at the end of this call, append ${CONTINUATION_MARKER} as the final line. The bridge removes it.`,
    "If the answer is fully complete, do not append the marker.",
    "",
    "Original request for constraints only:",
    "<<<REQUEST>>>",
    originalPrompt,
    "<<<END_REQUEST>>>",
  ].join("\n");
}

export async function runArenaModelsTestWithContinuations({
  body,
  maxContinuations,
  contextChars,
  autoContinue = true,
  signal,
}) {
  let currentBody = body;
  let content = "";
  let usage = null;
  let messageId = null;
  let finishReason = "stop";
  let finalError = null;
  let continuationReason = null;
  const rounds = [];

  for (let round = 0; round <= maxContinuations; round += 1) {
    throwIfAborted(signal);
    const res = await postArenaModelsTest(currentBody, { signal });
    const parsed = await collectArenaResponse(res, { signal });
    const roundContent = stripOverlap(content, parsed.content, contextChars);
    content += roundContent;
    usage = mergeUsage(usage, parsed.usage);
    messageId = messageId || parsed.messageId;
    finishReason = parsed.finishReason || finishReason;
    finalError = parsed.error;
    continuationReason = shouldContinueArenaResponse(parsed);

    rounds.push({
      round,
      status: res.status,
      contentLength: roundContent.length,
      rawContentLength: parsed.content.length,
      reasoningLength: parsed.reasoningContent?.length || 0,
      reasoningEventCount: parsed.reasoningEventCount || 0,
      continuationMarkerSeen: parsed.continuationMarkerSeen,
      finishStepSeen: parsed.finishStepSeen,
      finishMessageSeen: parsed.finishMessageSeen,
      terminalEventSeen: parsed.terminalEventSeen,
      finishReason: parsed.finishReason,
      error: parsed.error,
      continuationReason,
    });

    if (!autoContinue || !continuationReason) break;
    if (round >= maxContinuations) {
      finishReason = "length";
      break;
    }

    currentBody = {
      ...body,
      prompt: buildContinuationPrompt({
        originalPrompt: body.prompt,
        accumulatedContent: content,
        reason: continuationReason,
        contextChars,
      }),
    };
  }

  const recoverableError =
    finalError &&
    (isTimeoutLikeError(finalError) || continuationReason === "stream_closed_without_terminal_event");
  return {
    content,
    usage,
    messageId,
    finishReason,
    error: recoverableError && content ? null : finalError,
    rounds,
    continuationReason,
    continuationCount: Math.max(0, rounds.length - 1),
    continuationExhausted: Boolean(autoContinue && continuationReason && rounds.length > maxContinuations),
  };
}

export function parseArenaLine(line) {
  if (!line) return null;
  const idx = line.indexOf(":");
  if (idx === -1) return { type: "unknown", raw: line };
  const prefix = line.slice(0, idx);
  const payload = line.slice(idx + 1);
  try {
    if (prefix === "0") return { type: "content", value: JSON.parse(payload), raw: line };
    if (prefix === "3") return { type: "error", value: JSON.parse(payload), raw: line };
    if (prefix === "f") return { type: "frame", value: JSON.parse(payload), raw: line };
    if (prefix === "g") return { type: "reasoning", value: JSON.parse(payload), raw: line };
    if (prefix === "i") return { type: "redacted_reasoning", value: JSON.parse(payload), raw: line };
    if (prefix === "j") return { type: "reasoning_signature", value: JSON.parse(payload), raw: line };
    if (prefix === "e") return { type: "event", value: JSON.parse(payload), raw: line };
    if (prefix === "d") return { type: "done", value: JSON.parse(payload), raw: line };
    if (prefix === "8") return { type: "metadata", value: JSON.parse(payload), raw: line };
  } catch {
    return { type: "parse_error", prefix, payload, raw: line };
  }
  return { type: "unknown", prefix, payload, raw: line };
}

export async function collectArenaResponse(res, { signal } = {}) {
  throwIfAborted(signal);
  const text = await res.text();
  throwIfAborted(signal);
  const contentType = res.headers.get("content-type") || "";
  const parsed = {
    raw: text,
    messageId: null,
    content: "",
    reasoningContent: "",
    reasoningEventCount: 0,
    continuationMarkerSeen: false,
    error: null,
    finishReason: null,
    usage: null,
    finishStepSeen: false,
    finishMessageSeen: false,
    terminalEventSeen: false,
    events: [],
  };

  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(text);
      parsed.error =
        json?.error?.message ||
        json?.error?.name ||
        json?.error ||
        json?.message ||
        (res.ok ? null : `Arena HTTP ${res.status}`);
      parsed.events.push({ type: "json", value: json, raw: text });
      return parsed;
    } catch {
      if (!res.ok) {
        parsed.error = `Arena HTTP ${res.status}: ${text.slice(0, 300)}`;
        return parsed;
      }
    }
  }

  if (!res.ok) parsed.error = `Arena HTTP ${res.status}: ${text.slice(0, 300)}`;

  for (const line of text.split(/\r?\n/)) {
    const event = parseArenaLine(line.trim());
    if (!event) continue;
    parsed.events.push(event);
    if (event.type === "frame") parsed.messageId = event.value.messageId || parsed.messageId;
    if (event.type === "content") parsed.content += eventText(event.value);
    if (event.type === "reasoning" || event.type === "redacted_reasoning") {
      parsed.reasoningContent += eventText(event.value);
      parsed.reasoningEventCount += 1;
    }
    if (event.type === "error") parsed.error = event.value;
    if (event.type === "event") {
      parsed.finishStepSeen = true;
      parsed.finishReason = event.value.finishReason || parsed.finishReason;
      parsed.usage = event.value.usage || parsed.usage;
    }
    if (event.type === "done") {
      parsed.finishMessageSeen = true;
      parsed.terminalEventSeen = true;
      parsed.finishReason = event.value.finishReason || parsed.finishReason;
      parsed.usage = event.value.usage || parsed.usage;
    }
    if (event.type === "metadata" && Array.isArray(event.value) && event.value[0]?.usage) {
      parsed.usage = event.value[0].usage;
    }
  }
  if (parsed.content.includes(CONTINUATION_MARKER)) {
    parsed.continuationMarkerSeen = true;
    parsed.content = removeContinuationMarkers(parsed.content);
  }
  return parsed;
}
