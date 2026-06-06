import {
  buildContinuationPrompt,
  CONTINUATION_MARKER,
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
} from "./arena.js";
import { randomUUID } from "node:crypto";

export function makeChatCompletion({ id, model, content, finishReason = "stop", usage = null }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: finishReason === "unknown" ? "stop" : finishReason,
      },
    ],
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

function createContinuationMarkerFilter(onContent, onMarker) {
  let pending = "";
  const keepChars = CONTINUATION_MARKER.length - 1;

  return {
    push(content) {
      if (!content) return true;
      pending += content;

      for (;;) {
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
        continuationMarkerSeen: false,
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
      continuationMarkerSeen: false,
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
          continuationMarkerSeen: false,
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
      continuationMarkerSeen: false,
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
    continuationMarkerSeen: false,
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

  const markerFilter = createContinuationMarkerFilter(emitSseContent, () => {
    parsed.continuationMarkerSeen = true;
  });

  const emitContent = (content) => {
    if (!content || signal?.aborted || !responseWritable(httpResponse)) return false;
    return markerFilter.push(content);
  };

  const overlapSearchChars = Math.max(2000, contextChars || 2000);
  let overlapResolved = round === 0;
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
        if (!responseWritable(httpResponse)) return { ...parsed, aborted: true };
      }
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
  if (buffer.trim()) handleLine(buffer);
  if (!overlapResolved) flushPendingOverlap();
  markerFilter.flush();
  if (parsed.content.includes(CONTINUATION_MARKER)) {
    parsed.continuationMarkerSeen = true;
    parsed.content = removeContinuationMarkers(parsed.content);
  }

  parsed.continuationReason = shouldContinueArenaResponse(parsed);
  return parsed;
}

export async function streamArenaAsOpenAI({
  arenaBody,
  httpResponse,
  model,
  diagnosis = null,
  autoContinue = true,
  maxContinuations = 12,
  contextChars = 12000,
  signal,
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
  let continuationExhausted = false;

  if (!sse(httpResponse, {
    id: completionIdRef.value,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })) {
    return;
  }

  const heartbeat = setInterval(() => {
    if (signal?.aborted || !writeRaw(httpResponse, ": keepalive\n\n")) clearInterval(heartbeat);
  }, 15000);
  heartbeat.unref?.();

  try {
    let currentBody = arenaBody;
    for (let round = 0; round <= maxContinuations; round += 1) {
      throwIfAborted(signal);
      const result = await streamOneArenaRound({
        arenaBody: currentBody,
        httpResponse,
        model,
        created,
        completionIdRef,
        diagnosis,
        previousContent: accumulatedContent,
        round,
        signal,
        contextChars,
      });

      if (result.aborted || signal?.aborted || !responseWritable(httpResponse)) return;
      accumulatedContent += result.emittedContent;
      usage = mergeUsage(usage, result.usage);
      finishReason = result.finishReason || finishReason;

      if (result.fatal || (result.error && !isTimeoutLikeError(result.error))) {
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
      if (!autoContinue || !continuationReason) break;
      if (round >= maxContinuations) {
        continuationExhausted = true;
        finishReason = "length";
        break;
      }

      currentBody = {
        ...arenaBody,
        prompt: buildContinuationPrompt({
          originalPrompt: arenaBody.prompt,
          accumulatedContent,
          reason: continuationReason,
          contextChars,
        }),
      };
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted || !responseWritable(httpResponse)) return;
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
