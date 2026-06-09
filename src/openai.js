import {
  buildContinuationPrompt,
  CONTINUATION_MARKER,
  STOP_MARKER,
  countWordsAndCharacters,
  eventText,
  isAbortError,
  isTimeoutLikeError,
  mergeUsage,
  parseArenaLine,
  postArenaModelsTest,
  removeContinuationMarkers,
  shouldContinueArenaResponse,
  stripOverlap,
  throwIfAborted,
  getBeijingTimestamp,
  logContinuationStart,
  logContinuationResponse,
} from "./arena.js";
import { randomUUID } from "node:crypto";
import { XmlToolCallStreamTransformer } from "./tools.js";
import { saveImageAndGetUrl } from "./images.js";

export function makeChatCompletion({ id, model, content, toolCalls = null, finishReason = "stop", usage = null }) {
  const created = Math.floor(Date.now() / 1000);
  const choice = {
    index: 0,
    message: {
      role: "assistant",
      content: content || null,
    },
    finish_reason: finishReason === "unknown" ? "stop" : finishReason,
  };

  if (toolCalls && toolCalls.length > 0) {
    choice.message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      type: "function",
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
      },
    }));
    choice.finish_reason = "tool_calls";
  }

  return {
    id: id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [choice],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens ?? 0,
          completion_tokens: usage.completionTokens ?? 0,
          total_tokens:
            usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
        }
      : undefined,
  };
}

function responseWritable(res) {
  return !res.destroyed && !res.writableEnded;
}

function writeRaw(res, text) {
  if (!responseWritable(res)) return false;
  try {
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

function sse(res, data) {
  return writeRaw(res, `data: ${JSON.stringify(data)}\n\n`);
}

function toOpenAIUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokens ?? 0,
    completion_tokens: usage.completionTokens ?? 0,
    total_tokens:
      usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
  };
}

async function parseNonStreamArenaError(arenaResponse, diagnosis, signal) {
  throwIfAborted(signal);
  const text = await arenaResponse.text();
  throwIfAborted(signal);
  let message = text.slice(0, 500) || `Arena HTTP ${arenaResponse.status}`;
  try {
    const json = JSON.parse(text);
    message =
      json?.error?.message ||
      json?.error?.name ||
      json?.error ||
      json?.message ||
      message;
  } catch {
    // Keep the raw preview.
  }
  const upstreamMessage = String(message);
  return diagnosis && upstreamMessage === "BadRequestError"
    ? `${upstreamMessage}: ${diagnosis}`
    : upstreamMessage;
}

function pendingCouldStillBeOverlap(previousContent, pending, maxOverlap) {
  if (!previousContent || !pending) return false;
  const tail = previousContent.slice(-maxOverlap);
  if (pending.length > tail.length) return false;
  return tail.includes(pending);
}

function createContinuationMarkerFilter(onContent, onMarker, onStop) {
  let pending = "";
  const maxMarkerLen = Math.max(CONTINUATION_MARKER.length, STOP_MARKER.length);
  const keepChars = maxMarkerLen - 1;

  return {
    push(content) {
      if (!content) return true;
      pending += content;

      for (;;) {
        // Check for STOP_MARKER
        const stopAt = pending.indexOf(STOP_MARKER);
        if (stopAt !== -1) {
          const before = pending.slice(0, stopAt);
          if (before && onContent(before) === false) return false;
          onStop();
          pending = pending.slice(stopAt + STOP_MARKER.length);
          continue;
        }

        // Check for CONTINUATION_MARKER
        const markerAt = pending.indexOf(CONTINUATION_MARKER);
        if (markerAt !== -1) {
          const before = pending.slice(0, markerAt);
          if (before && onContent(before) === false) return false;
          onMarker();
          pending = pending.slice(markerAt + CONTINUATION_MARKER.length);
          continue;
        }

        if (pending.length <= keepChars) return true;
        const emitNow = pending.slice(0, pending.length - keepChars);
        pending = pending.slice(-keepChars);
        return emitNow ? onContent(emitNow) : true;
      }
    },
    flush() {
      if (!pending) return true;
      const final = pending;
      pending = "";
      return onContent(final);
    },
  };
}

async function streamOneArenaRound({
  arenaBody,
  httpResponse,
  model,
  created,
  completionIdRef,
  diagnosis,
  previousContent,
  round,
  signal,
  contextChars,
  transformer,
  host = null,
}) {
  let arenaResponse;
  try {
    throwIfAborted(signal);
    arenaResponse = await postArenaModelsTest(arenaBody, { signal });
  } catch (error) {
    if (isAbortError(error)) {
      return {
        aborted: true,
        fatal: false,
        error: null,
        arenaStatus: null,
        content: "",
        reasoningContent: "",
        reasoningEventCount: 0,
        emittedContent: "",
        rawEmittedContent: "",
        continuationMarkerSeen: false,
        incompleteToolCalls: false,
        finishStepSeen: false,
        finishMessageSeen: false,
        terminalEventSeen: false,
        finishReason: null,
        usage: null,
        events: [],
      };
    }
    return {
      aborted: false,
      fatal: true,
      error: error?.message || String(error),
      arenaStatus: null,
      content: "",
      reasoningContent: "",
      reasoningEventCount: 0,
      emittedContent: "",
      rawEmittedContent: "",
      continuationMarkerSeen: false,
      incompleteToolCalls: false,
      finishStepSeen: false,
      finishMessageSeen: false,
      terminalEventSeen: false,
      finishReason: null,
      usage: null,
      events: [],
    };
  }

  const arenaContentType = arenaResponse.headers.get("content-type") || "";
  if (!arenaContentType.includes("text/event-stream")) {
    let upstreamError;
    try {
      upstreamError = await parseNonStreamArenaError(arenaResponse, diagnosis, signal);
    } catch (error) {
      if (isAbortError(error)) {
        return {
          aborted: true,
          fatal: false,
          error: null,
          arenaStatus: arenaResponse.status,
          content: "",
          reasoningContent: "",
          reasoningEventCount: 0,
          emittedContent: "",
          rawEmittedContent: "",
          continuationMarkerSeen: false,
          incompleteToolCalls: false,
          finishStepSeen: false,
          finishMessageSeen: false,
          terminalEventSeen: false,
          finishReason: null,
          usage: null,
          events: [],
        };
      }
      throw error;
    }
    return {
      aborted: false,
      fatal: true,
      error: upstreamError,
      arenaStatus: arenaResponse.status,
      content: "",
      reasoningContent: "",
      reasoningEventCount: 0,
      emittedContent: "",
      rawEmittedContent: "",
      continuationMarkerSeen: false,
      incompleteToolCalls: false,
      finishStepSeen: false,
      finishMessageSeen: false,
      terminalEventSeen: false,
      finishReason: null,
      usage: null,
      events: [],
    };
  }

  const parsed = {
    aborted: false,
    fatal: false,
    error: null,
    arenaStatus: arenaResponse.status,
    content: "",
    reasoningContent: "",
    reasoningEventCount: 0,
    emittedContent: "",
    rawEmittedContent: "",
    continuationMarkerSeen: false,
    incompleteToolCalls: false,
    finishStepSeen: false,
    finishMessageSeen: false,
    terminalEventSeen: false,
    finishReason: null,
    usage: null,
    events: [],
  };

  const emitSseContent = (content) => {
    if (!content || signal?.aborted || !responseWritable(httpResponse)) return false;
    parsed.emittedContent += content;
    return sse(httpResponse, {
      id: completionIdRef.value,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  };

  const markerFilter = createContinuationMarkerFilter(
    emitSseContent,
    () => {
      parsed.continuationMarkerSeen = true;
    },
    () => {
      parsed.endMarkerSeen = true;
    }
  );

  if (transformer) {
    transformer.onContent = (content) => {
      return markerFilter.push(content);
    };
  }

  const emitContent = (content) => {
    if (!content || signal?.aborted || !responseWritable(httpResponse)) return false;
    parsed.rawEmittedContent += content;
    if (transformer) {
      transformer.write(content);
      return true;
    }
    return markerFilter.push(content);
  };

  const overlapSearchChars = Math.max(2000, contextChars || 2000);
  let overlapResolved = true; // round === 0; // Commented out overlap stripping: always resolved
  let pendingOverlap = "";

  const flushPendingOverlap = () => {
    if (overlapResolved) return;
    emitContent(stripOverlap(previousContent, pendingOverlap, overlapSearchChars));
    pendingOverlap = "";
    overlapResolved = true;
  };

  const handleContent = (content) => {
    parsed.content += content;
    if (overlapResolved) {
      emitContent(content);
      return;
    }

    pendingOverlap += content;
    if (!pendingCouldStillBeOverlap(previousContent, pendingOverlap, overlapSearchChars)) {
      flushPendingOverlap();
    }
  };

  const handleLine = (line) => {
    const event = parseArenaLine(line.trim());
    if (!event) return;
    parsed.events.push(event);
    if (event.type === "frame" && event.value.messageId && !completionIdRef.hasArenaId) {
      completionIdRef.value = event.value.messageId;
      completionIdRef.hasArenaId = true;
    }
    if (event.type === "content" && event.value) handleContent(eventText(event.value));
    if (event.type === "image" && event.value?.data) {
      try {
        const imageUrl = saveImageAndGetUrl(event.value.data, host);
        const mdImage = `\n![image](${imageUrl})\n`;
        handleContent(mdImage);
      } catch (err) {
        console.error("Failed to save image in streamOneArenaRound:", err);
        const mdImage = `\n![image](data:image/png;base64,${event.value.data})\n`;
        handleContent(mdImage);
      }
    }
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
  };

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of arenaResponse.body) {
      if (signal?.aborted || !responseWritable(httpResponse)) {
        return { ...parsed, aborted: true };
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        throwIfAborted(signal);
        handleLine(line);
        if (parsed.endMarkerSeen) break;
        if (!responseWritable(httpResponse)) return { ...parsed, aborted: true };
      }
      if (parsed.endMarkerSeen) break;
    }
  } catch (error) {
    if (isAbortError(error)) return { ...parsed, aborted: true };
    return {
      ...parsed,
      fatal: true,
      error: error?.message || String(error),
    };
  }
  buffer += decoder.decode();
  if (buffer.trim() && !parsed.endMarkerSeen) handleLine(buffer);
  if (!overlapResolved) flushPendingOverlap();
  if (transformer) {
    transformer.flush();
    parsed.incompleteToolCalls = transformer.hasUnclosedToolCalls();
  }
  markerFilter.flush();
  if (parsed.content.includes(CONTINUATION_MARKER)) {
    parsed.continuationMarkerSeen = true;
    parsed.content = removeContinuationMarkers(parsed.content);
  }
  if (parsed.content.includes(STOP_MARKER)) {
    parsed.endMarkerSeen = true;
    parsed.content = parsed.content.replaceAll(STOP_MARKER, "");
  }

  parsed.continuationReason = shouldContinueArenaResponse(parsed);
  return parsed;
}

export async function streamArenaAsOpenAI({
  arenaBody,
  httpResponse,
  model,
  clientModel = null,
  diagnosis = null,
  autoContinue = true,
  maxContinuations = 20,
  contextChars = 12000,
  signal,
  tools = [],
  host = null,
}) {
  if (!responseWritable(httpResponse)) return;
  httpResponse.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  httpResponse.socket?.setNoDelay?.(true);
  httpResponse.flushHeaders?.();

  const created = Math.floor(Date.now() / 1000);
  const completionIdRef = { value: `chatcmpl-${randomUUID()}`, hasArenaId: false };
  let finishReason = "stop";
  let usage = null;
  let accumulatedContent = "";
  let accumulatedRawContent = "";
  let continuationExhausted = false;
  let clientDisconnectedEarly = false;
  let hasError = false;

  const emitSseToolCall = ({ index, id, name, argumentsChunk }) => {
    if (signal?.aborted || !responseWritable(httpResponse)) return false;
    const toolCall = { index, id };
    if (name) {
      toolCall.type = "function";
      toolCall.function = { name, arguments: "" };
      finishReason = "tool_calls";
    }
    if (argumentsChunk !== undefined) {
      toolCall.function = { arguments: argumentsChunk };
      finishReason = "tool_calls";
    }
    return sse(httpResponse, {
      id: completionIdRef.value,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
    });
  };

  const transformer = new XmlToolCallStreamTransformer({
    tools,
    onContent: () => {},
    onToolCall: emitSseToolCall,
  });

  if (!sse(httpResponse, {
    id: completionIdRef.value,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })) {
    clientDisconnectedEarly = true;
    return;
  }

  const heartbeat = setInterval(() => {
    if (signal?.aborted || !writeRaw(httpResponse, ": keepalive\n\n")) {
      clientDisconnectedEarly = true;
      clearInterval(heartbeat);
    }
  }, 15000);
  heartbeat.unref?.();

  try {
    let currentBody = arenaBody;
    for (let round = 0; round <= maxContinuations; round += 1) {
      throwIfAborted(signal);

      if (round > 0) {
        logContinuationStart({
          round,
          modelId: clientModel || model,
          stream: true,
          prompt: currentBody.prompt,
          request: arenaBody,
        });
      }

      const result = await streamOneArenaRound({
        arenaBody: currentBody,
        httpResponse,
        model,
        created,
        completionIdRef,
        diagnosis,
        previousContent: accumulatedRawContent,
        round,
        signal,
        contextChars,
        transformer,
        host,
      });

      if (result.aborted || signal?.aborted || !responseWritable(httpResponse)) {
        clientDisconnectedEarly = true;
        return;
      }

      if (round > 0) {
        const status = result.fatal ? 500 : (result.aborted ? "200 (Client disconnected early)" : 200);
        logContinuationResponse({
          round,
          modelId: clientModel || model,
          stream: true,
          prompt: currentBody.prompt,
          status,
          outputContent: result.emittedContent,
        });
      }

      accumulatedContent += result.emittedContent;
      accumulatedRawContent += result.rawEmittedContent || "";
      usage = mergeUsage(usage, result.usage);
      if (finishReason !== "tool_calls") {
        finishReason = result.finishReason || finishReason;
      }

      if (result.fatal || (result.error && !isTimeoutLikeError(result.error))) {
        hasError = true;
        sse(httpResponse, {
          error: {
            message: String(result.error),
            type: result.fatal ? "arena_upstream_fetch_error" : "arena_provider_error",
            arena_status: result.arenaStatus,
          },
        });
        writeRaw(httpResponse, "data: [DONE]\n\n");
        if (responseWritable(httpResponse)) httpResponse.end();
        return;
      }

      const continuationReason = result.continuationReason;
      if (!autoContinue || !continuationReason) {
        if (continuationReason === "unclosed_tool_calls") {
          finishReason = "length";
        }
        break;
      }
      if (round >= maxContinuations) {
        continuationExhausted = true;
        finishReason = "length";
        break;
      }

      currentBody = {
        ...arenaBody,
        prompt: buildContinuationPrompt({
          originalPrompt: arenaBody.prompt,
          accumulatedContent: accumulatedRawContent,
          reason: continuationReason,
          contextChars,
        }),
      };
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted || !responseWritable(httpResponse)) {
      clientDisconnectedEarly = true;
      return;
    }
    hasError = true;
    sse(httpResponse, {
      error: {
        message: error?.message || String(error),
        type: "bridge_stream_error",
      },
    });
    writeRaw(httpResponse, "data: [DONE]\n\n");
    if (responseWritable(httpResponse)) httpResponse.end();
    return;
  } finally {
    clearInterval(heartbeat);
    const logModel = clientModel || model;
    const prompt = arenaBody.prompt || "";
    const inputLen = prompt.length;
    const inputWords = countWordsAndCharacters(prompt);
    const outputChars = accumulatedContent.length;
    const outputWords = countWordsAndCharacters(accumulatedContent);
    if (clientDisconnectedEarly || signal?.aborted || !responseWritable(httpResponse)) {
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${logModel} | Stream: True | Input: ${inputLen} chars (${inputWords} words) | Status: 200 (Client disconnected early) | Output: ${outputChars} chars (${outputWords} words)`);
    } else if (hasError) {
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${logModel} | Stream: True | Input: ${inputLen} chars (${inputWords} words) | Status: 500 | Output: ${outputChars} chars (${outputWords} words)`);
    } else {
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${logModel} | Stream: True | Input: ${inputLen} chars (${inputWords} words) | Status: 200 | Output: ${outputChars} chars (${outputWords} words)`);
    }
  }

  if (signal?.aborted || !responseWritable(httpResponse)) return;
  sse(httpResponse, {
    id: completionIdRef.value,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason:
          continuationExhausted || finishReason === "length"
            ? "length"
            : finishReason === "unknown"
              ? "stop"
              : finishReason,
      },
    ],
    usage: toOpenAIUsage(usage),
  });
  writeRaw(httpResponse, "data: [DONE]\n\n");
  if (responseWritable(httpResponse)) httpResponse.end();
}
