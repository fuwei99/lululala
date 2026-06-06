import http from "node:http";
import {
  API_KEY,
  AUTO_CONTINUE,
  CONTINUATION_CONTEXT_CHARS,
  ENABLE_LIVE,
  HOST,
  LATENCY_HINT,
  LATENCY_HINT_TEXT,
  MAX_CONTINUATIONS,
  PORT,
} from "./config.js";
import { buildArenaBody, isAbortError, runArenaModelsTestWithContinuations } from "./arena.js";
import {
  isVerifiedModelsTestModel,
  loadArenaCatalog,
  resolveModel,
  toOpenAIModel,
} from "./catalog.js";
import { makeChatCompletion, streamArenaAsOpenAI } from "./openai.js";
import { applyLatencyHint, formatMessagesAsStructuredPrompt } from "./roles.js";

function responseWritable(res) {
  return !res.destroyed && !res.writableEnded;
}

function sendJson(res, status, obj) {
  if (!responseWritable(res)) return false;
  const body = JSON.stringify(obj, null, 2);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function attachClientAbortSignal(req, res) {
  const controller = new AbortController();
  let finished = false;

  const abort = () => {
    if (!finished && !controller.signal.aborted) controller.abort("client_closed");
  };
  const finish = () => {
    finished = true;
  };
  const close = () => {
    if (!finished) abort();
  };

  req.on("aborted", abort);
  res.on("finish", finish);
  res.on("close", close);

  return {
    signal: controller.signal,
    markFinished: finish,
    cleanup() {
      req.off("aborted", abort);
      res.off("finish", finish);
      res.off("close", close);
    },
  };
}

function checkClientAuth(req) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${API_KEY}`;
}

function logRequestSummary(request, model) {
  const rawMaxTokens = request.max_tokens ?? request.max_completion_tokens;
  const ignoredMaxTokens =
    typeof rawMaxTokens === "number" && Number.isInteger(rawMaxTokens) && rawMaxTokens < 16;
  const roles = Array.isArray(request.messages)
    ? request.messages.map((m) => m?.role || "unknown")
    : [];
  console.log(
    JSON.stringify({
      event: "chat_request",
      model: request.model,
      resolved_model: `${model.provider}/${model.apiModelName}`,
      models_test_model: `${model.modelsTestProvider || model.provider}/${model.modelsTestApiModelName || model.apiModelName}`,
      stream: request.stream === true,
      message_count: Array.isArray(request.messages) ? request.messages.length : 0,
      roles,
      max_tokens: rawMaxTokens ?? null,
      ignored_invalid_low_max_tokens: ignoredMaxTokens,
    }),
  );
}

function stringifyError(error) {
  if (error == null) return null;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function integerRequestParam(value, fallback, { min = 0, max = 24 } = {}) {
  if (!Number.isInteger(value) || value < min) return fallback;
  return Math.min(value, max);
}

function requestAutoContinue(request) {
  if (request.arena_auto_continue === false) return false;
  if (request.auto_continue === false) return false;
  return AUTO_CONTINUE;
}

function diagnoseArenaError(error, model) {
  const message = stringifyError(error);
  if (message !== "BadRequestError") return null;
  const outputs = model.outputCapabilities || [];
  if (outputs.includes("text")) return null;
  return [
    "Arena /nextjs-api/models/test rejected this non-text output capability branch.",
    `output_capabilities=${outputs.join("+") || "none"}.`,
    "Search/image/video/web-only models use Arena's stream create-evaluation flow with modelId/modality/recaptcha, not the unauthenticated models/test text path.",
  ].join(" ");
}

async function handleModels(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const refresh = url.searchParams.get("refresh") === "1";
  const hiddenOnly = url.searchParams.get("hidden") === "1";
  const includeAllTheoretical =
    url.searchParams.get("all") === "1" || url.searchParams.get("theoretical") === "1";
  const catalog = await loadArenaCatalog({ refresh });
  const baseList = includeAllTheoretical
    ? catalog.callable
    : catalog.callable.filter(isVerifiedModelsTestModel);
  const list = hiddenOnly ? baseList.filter((m) => !m.userSelectable) : baseList;
  sendJson(res, 200, {
    object: "list",
    data: list.map(toOpenAIModel),
    arena_bridge: {
      fetched_at: catalog.fetchedAt,
      deploy_ids: catalog.deployIds,
      counts: catalog.counts,
      live_calls_enabled: ENABLE_LIVE,
      local_model_filter: "none",
      model_list_mode: includeAllTheoretical ? "all_theoretical_candidates" : "verified_successes",
      note:
        includeAllTheoretical
          ? "This is the theoretical provider/name/capability candidate list for /nextjs-api/models/test; completed inference must be validated per model."
          : "Default list is restricted to selectors with prior completed inference evidence or corrected aliases backed by completed inference evidence. Use ?all=1 for the broader theoretical candidate list.",
      auto_continue_enabled: AUTO_CONTINUE,
      latency_hint_enabled: LATENCY_HINT,
      max_continuations: MAX_CONTINUATIONS,
    },
  });
}

async function handleChatCompletions(req, res) {
  if (!ENABLE_LIVE) {
    sendJson(res, 403, {
      error: {
        message: "Live Arena calls are disabled. Set LMARENA_ENABLE_LIVE=1 for a controlled reviewer run.",
        type: "live_calls_disabled",
      },
    });
    return;
  }

  const client = attachClientAbortSignal(req, res);
  try {
  const request = await readJson(req);
  if (client.signal.aborted) return;
  const catalog = await loadArenaCatalog({ signal: client.signal });
  if (client.signal.aborted) return;
  const model = resolveModel(catalog, request.model);
  logRequestSummary(request, model);

  const basePrompt = formatMessagesAsStructuredPrompt(request.messages);
  const latencyHintEnabled = LATENCY_HINT && request.arena_latency_hint !== false;
  const prompt = latencyHintEnabled ? applyLatencyHint(basePrompt, LATENCY_HINT_TEXT) : basePrompt;
  const arenaBody = buildArenaBody({ model, prompt, request });
  const modelsTestProvider = model.modelsTestProvider || model.provider;
  const openaiModelId = `${modelsTestProvider}/${model.modelsTestApiModelName || model.apiModelName}`;
  const diagnosis = diagnoseArenaError("BadRequestError", model);
  const autoContinue = requestAutoContinue(request);
  const maxContinuations = integerRequestParam(
    request.arena_max_continuations ?? request.max_continuations,
    MAX_CONTINUATIONS,
  );

  if (request.stream) {
    await streamArenaAsOpenAI({
      arenaBody,
      httpResponse: res,
      model: openaiModelId,
      diagnosis,
      autoContinue,
      maxContinuations,
      contextChars: CONTINUATION_CONTEXT_CHARS,
      signal: client.signal,
    });
    client.markFinished();
    return;
  }

  const completed = await runArenaModelsTestWithContinuations({
    body: arenaBody,
    autoContinue,
    maxContinuations,
    contextChars: CONTINUATION_CONTEXT_CHARS,
    signal: client.signal,
  });
  if (client.signal.aborted) return;
  const lastRound = completed.rounds.at(-1);
  if (completed.error) {
    const upstreamError = stringifyError(completed.error);
    const parsedDiagnosis = diagnoseArenaError(completed.error, model);
    sendJson(res, 502, {
      error: {
        message: parsedDiagnosis ? `${upstreamError}: ${parsedDiagnosis}` : upstreamError,
        type: "arena_provider_error",
        arena_status: lastRound?.status ?? null,
      },
      arena_bridge: {
        model: openaiModelId,
        arena_model_id: model.id,
        user_selectable: model.userSelectable,
        catalog_model_id: `${model.provider}/${model.apiModelName}`,
        arena_models_test_selector: openaiModelId,
        catalog_api_model_name: model.apiModelName,
        arena_models_test_provider: modelsTestProvider,
        arena_models_test_api_model_name: model.modelsTestApiModelName || model.apiModelName,
        arena_models_test_default_inference_settings:
          model.modelsTestDefaultInferenceSettings || null,
        arena_models_test_inference_settings: arenaBody.inferenceSettings || null,
        arena_models_test_alias_reason: model.modelsTestAliasReason || null,
        output_capabilities: model.outputCapabilities,
        upstream_error: upstreamError,
        diagnosis: parsedDiagnosis,
        auto_continue_enabled: autoContinue,
        latency_hint_enabled: latencyHintEnabled,
        max_continuations: maxContinuations,
        continuation_count: completed.continuationCount,
        continuation_exhausted: completed.continuationExhausted,
        continuation_rounds: completed.rounds,
      },
    });
    client.markFinished();
    return;
  }

  sendJson(
    res,
    200,
    {
      ...makeChatCompletion({
        id: completed.messageId,
        model: openaiModelId,
        content: completed.content,
        finishReason: completed.finishReason,
        usage: completed.usage,
      }),
      arena_bridge: {
        endpoint: "/nextjs-api/models/test",
        arena_model_id: model.id,
        provider: model.provider,
        catalog_model_id: `${model.provider}/${model.apiModelName}`,
        arena_models_test_selector: openaiModelId,
        api_model_name: model.modelsTestApiModelName || model.apiModelName,
        catalog_api_model_name: model.apiModelName,
        arena_models_test_provider: modelsTestProvider,
        arena_models_test_default_inference_settings:
          model.modelsTestDefaultInferenceSettings || null,
        arena_models_test_inference_settings: arenaBody.inferenceSettings || null,
        arena_models_test_alias_reason: model.modelsTestAliasReason || null,
        user_selectable: model.userSelectable,
        role_mapping: "structured_prompt_transcript",
        auto_continue_enabled: autoContinue,
        latency_hint_enabled: latencyHintEnabled,
        max_continuations: maxContinuations,
        continuation_count: completed.continuationCount,
        continuation_exhausted: completed.continuationExhausted,
        continuation_rounds: completed.rounds,
      },
    },
  );
  client.markFinished();
  } catch (err) {
    if (client.signal.aborted || isAbortError(err)) return;
    throw err;
  } finally {
    client.cleanup();
  }
}

async function router(req, res) {
  try {
    if (!checkClientAuth(req)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "invalid_api_key" } });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        live_calls_enabled: ENABLE_LIVE,
        auto_continue_enabled: AUTO_CONTINUE,
        latency_hint_enabled: LATENCY_HINT,
        max_continuations: MAX_CONTINUATIONS,
        continuation_context_chars: CONTINUATION_CONTEXT_CHARS,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModels(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
  } catch (err) {
    if (isAbortError(err) || !responseWritable(res)) return;
    sendJson(res, 500, {
      error: {
        message: err?.message || String(err),
        type: "bridge_error",
      },
    });
  }
}

const server = http.createServer(router);
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;
server.listen(PORT, HOST, () => {
  console.log(`LMArenaBridge listening on http://${HOST}:${PORT}`);
  console.log(`live calls enabled: ${ENABLE_LIVE}`);
  console.log("local model filter: none");
});
