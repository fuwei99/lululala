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
import { buildArenaBody, isAbortError, runArenaModelsTestWithContinuations, getBeijingTimestamp, countWordsAndCharacters } from "./arena.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeChatCompletion, streamArenaAsOpenAI } from "./openai.js";
import { applyLatencyHint, formatMessagesAsClaudePrompt, formatMessagesAsStructuredPrompt } from "./roles.js";
import {
  preprocessHistoryMessages,
  injectToolsIntoMessages,
  hasUnclosedToolCalls,
  parseAllToolCalls,
  stripToolCalls
} from "./tools.js";
import { saveImageAndGetUrl } from "./images.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const imgDir = join(__dirname, "..", "generated_images");


function loadModelsConfig() {
  try {
    const url = new URL("../models.jsonc", import.meta.url);
    const content = readFileSync(url, "utf8");
    // Remove single line comments // ... and block comments /* ... */
    const cleaned = content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to load models.jsonc:", e);
    return {};
  }
}

function toOpenAIModelFromConfig(modelId, config) {
  const inputCaps = Object.keys(config.capabilities?.inputCapabilities || {}).sort();
  const outputCaps = Object.keys(config.capabilities?.outputCapabilities || {}).sort();
  return {
    id: modelId,
    object: "model",
    created: 0,
    owned_by: config.provider || "arena",
    arena_model_id: modelId,
    catalog_model_id: `${config.provider}/${config.apiModelName}`,
    arena_models_test_selector: `${config.provider}/${config.apiModelName}`,
    api_model_name: config.apiModelName,
    catalog_api_model_name: config.apiModelName,
    arena_models_test_api_model_name: config.apiModelName,
    arena_models_test_provider: config.provider,
    arena_models_test_default_inference_settings: config.modelsTestDefaultInferenceSettings || null,
    arena_models_test_alias_reason: null,
    provider: config.provider,
    public_name: modelId,
    display_name: modelId,
    user_selectable: true,
    catalog_status: "configured",
    discovered_by_models_test: false,
    evidence_artifact: null,
    theoretical_callable: true,
    input_capabilities: inputCaps,
    output_capabilities: outputCaps,
  };
}

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

function logReceivedRequest(path, request, model, prompt) {
  const input_len = prompt ? prompt.length : 0;
  const input_words = countWordsAndCharacters(prompt);
  const modelId = request.model || model?.id || "unknown";
  const stream = request.stream === true;

  if (path === "/v1/images/generations") {
    console.log(`${getBeijingTimestamp()} [Received] POST /v1/images/generations | Model: ${modelId} | Input: ${input_len} chars (${input_words} words)`);
    return;
  }

  // Chat completions logging
  const reasoning_effort = request.reasoning_effort ?? request.reasoning?.effort;
  const thinking = request.thinking;
  const provider = model?.modelsTestProvider || model?.provider;

  const log_parts = [
    `[Received] POST /v1/chat/completions`,
    `Model: ${modelId}`,
    `Stream: ${stream}`,
    `Input: ${input_len} chars (${input_words} words)`
  ];

  if (reasoning_effort !== undefined && reasoning_effort !== null) {
    log_parts.push(`Effort: ${reasoning_effort}`);
  }

  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    log_parts.push(`Thinking: ${thinking.type}`);
  } else if (provider === "deepseek" || provider === "deepseekToolCalling") {
    if (reasoning_effort === "none") {
      log_parts.push("Thinking: disabled");
    } else if (reasoning_effort !== undefined && reasoning_effort !== null) {
      log_parts.push("Thinking: enabled");
    }
  }

  const google_thinking = request.google_thinking;
  if (google_thinking && typeof google_thinking === "object" && !Array.isArray(google_thinking)) {
    if (google_thinking.thinking_budget !== undefined && google_thinking.thinking_budget !== null) {
      log_parts.push(`GoogleThinkingBudget: ${google_thinking.thinking_budget}`);
    }
  }

  console.log(`${getBeijingTimestamp()} ${log_parts.join(" | ")}`);
}

function logResponse(path, request, modelId, prompt, status, { outputContent = "", error = null, earlyDisconnect = false } = {}) {
  const input_len = prompt ? prompt.length : 0;
  const input_words = countWordsAndCharacters(prompt);
  const stream = request?.stream === true;

  if (path === "/v1/images/generations") {
    if (error) {
      console.log(`${getBeijingTimestamp()} [POST] /v1/images/generations | Model: ${modelId} | Input: ${input_len} chars (${input_words} words) | Status: ${status} | Error: ${error}`);
    } else {
      console.log(`${getBeijingTimestamp()} [POST] /v1/images/generations | Model: ${modelId} | Input: ${input_len} chars (${input_words} words) | Status: ${status} | Output: Image`);
    }
    return;
  }

  const output_len = outputContent ? outputContent.length : 0;
  const output_words = countWordsAndCharacters(outputContent);

  if (path === "/v1/chat/completions") {
    if (stream) {
      const statusText = earlyDisconnect ? "200 (Client disconnected early)" : String(status);
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${modelId} | Stream: True | Input: ${input_len} chars (${input_words} words) | Status: ${statusText} | Output: ${output_len} chars (${output_words} words)`);
    } else {
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${modelId} | Stream: False | Input: ${input_len} chars (${input_words} words) | Status: ${status} | Output: ${output_len} chars (${output_words} words)`);
    }
    return;
  }
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
  return null;
}

async function handleModels(req, res) {
  const modelsConfig = loadModelsConfig();
  const list = Object.entries(modelsConfig).map(([modelId, config]) =>
    toOpenAIModelFromConfig(modelId, config)
  );

  sendJson(res, 200, {
    object: "list",
    data: list,
    arena_bridge: {
      fetched_at: new Date().toISOString(),
      deploy_ids: [],
      counts: {
        totalCatalogModels: list.length,
        theoreticalCallable: list.length,
        publicSelectableCallable: list.length,
        hiddenNonSelectableCallable: 0,
        discoveredOffCatalogCallable: 0,
        excludedMissingProviderOrName: 0,
      },
      live_calls_enabled: ENABLE_LIVE,
      local_model_filter: "none",
      model_list_mode: "configured_models",
      note: "Model list is loaded dynamically from models.jsonc.",
      auto_continue_enabled: AUTO_CONTINUE,
      latency_hint_enabled: LATENCY_HINT,
      max_continuations: MAX_CONTINUATIONS,
    },
  });
  console.log(`${getBeijingTimestamp()} [GET] /v1/models | Status: 200`);
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
    let request;
    try {
      request = await readJson(req);
    } catch (e) {
      sendJson(res, 400, { error: { message: `Invalid JSON: ${e.message}`, type: "invalid_request_error" } });
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Status: 400 | Error: Invalid JSON`);
      client.markFinished();
      return;
    }
    if (client.signal.aborted) return;
    const modelsConfig = loadModelsConfig();
    const rawModel = modelsConfig[request.model];
    if (!rawModel) {
      sendJson(res, 400, {
        error: {
          message: `Unsupported model: ${request.model}. Supported: ${Object.keys(modelsConfig).join(", ")}`,
          type: "unsupported_model",
        },
      });
      console.log(`${getBeijingTimestamp()} [POST] /v1/chat/completions | Model: ${request.model} | Status: 400 | Error: Unsupported model`);
      client.markFinished();
      return;
    }
    const model = {
      ...rawModel,
      id: request.model,
      inputCapabilities: Object.keys(rawModel.capabilities?.inputCapabilities || {}).sort(),
      outputCapabilities: Object.keys(rawModel.capabilities?.outputCapabilities || {}).sort(),
    };

    const isClaude = request.model.toLowerCase().includes("claude") || 
                     (model.apiModelName && model.apiModelName.toLowerCase().includes("claude")) || 
                     model.provider === "anthropic";

    const preprocessedMessages = preprocessHistoryMessages(request.messages, isClaude);
    const messagesWithTools = injectToolsIntoMessages(preprocessedMessages, request.tools);

    const basePrompt = isClaude
      ? formatMessagesAsClaudePrompt(messagesWithTools)
      : formatMessagesAsStructuredPrompt(messagesWithTools);
    const latencyHintEnabled = LATENCY_HINT && request.arena_latency_hint !== false;
    const prompt = latencyHintEnabled ? applyLatencyHint(basePrompt, LATENCY_HINT_TEXT, isClaude) : basePrompt;

    logReceivedRequest("/v1/chat/completions", request, model, prompt);

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
        clientModel: request.model,
        diagnosis,
        autoContinue,
        maxContinuations,
        contextChars: CONTINUATION_CONTEXT_CHARS,
        signal: client.signal,
        tools: request.tools,
        host: req.headers.host,
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
      host: req.headers.host,
      clientModelId: openaiModelId,
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
          user_selectable: model.userSelectable !== false,
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
      logResponse("/v1/chat/completions", request, request.model, prompt, 502, { error: upstreamError, outputContent: completed.content || "" });
      client.markFinished();
      return;
    }

    const parsedToolCalls = parseAllToolCalls(completed.content);
    const hasToolCalls = parsedToolCalls.length > 0;
    const finalContent =
      hasToolCalls || hasUnclosedToolCalls(completed.content)
        ? stripToolCalls(completed.content)
        : completed.content;

    sendJson(
      res,
      200,
      {
        ...makeChatCompletion({
          id: completed.messageId,
          model: openaiModelId,
          content: finalContent,
          toolCalls: parsedToolCalls,
          finishReason: hasToolCalls ? "tool_calls" : completed.finishReason,
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
          user_selectable: model.userSelectable !== false,
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
    logResponse("/v1/chat/completions", request, request.model, prompt, 200, { outputContent: completed.content || "" });
    client.markFinished();
  } catch (err) {
    if (client.signal.aborted || isAbortError(err)) return;
    throw err;
  } finally {
    client.cleanup();
  }
}

async function handleServeImage(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filename = url.pathname.slice("/images/".length);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    sendJson(res, 400, { error: { message: "Bad request", type: "invalid_request_error" } });
    console.log(`${getBeijingTimestamp()} [GET] ${req.url} | Status: 400`);
    return;
  }
  const filePath = join(imgDir, filename);
  if (existsSync(filePath)) {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(readFileSync(filePath));
    console.log(`${getBeijingTimestamp()} [GET] ${req.url} | Status: 200`);
  } else {
    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    console.log(`${getBeijingTimestamp()} [GET] ${req.url} | Status: 404`);
  }
}

async function handleImagesGenerations(req, res) {
  if (!ENABLE_LIVE) {
    sendJson(res, 400, {
      error: {
        message: "Live calls to Arena are disabled in configuration",
        type: "live_calls_disabled",
      },
    });
    return;
  }

  const client = attachClientAbortSignal(req, res);
  try {
    let request;
    try {
      request = await readJson(req);
    } catch (e) {
      sendJson(res, 400, { error: { message: `Invalid JSON: ${e.message}`, type: "invalid_request_error" } });
      console.log(`${getBeijingTimestamp()} [POST] /v1/images/generations | Status: 400 | Error: Invalid JSON`);
      client.markFinished();
      return;
    }
    if (client.signal.aborted) return;

    const prompt = request.prompt;
    if (!prompt) {
      sendJson(res, 400, { error: { message: "Missing prompt in request body", type: "invalid_request_error" } });
      console.log(`${getBeijingTimestamp()} [POST] /v1/images/generations | Model: ${request.model || "gpt-image-2"} | Status: 400 | Error: Missing prompt`);
      client.markFinished();
      return;
    }

    const modelsConfig = loadModelsConfig();
    let rawModel = modelsConfig[request.model || "gpt-image-2"];
    if (!rawModel && (request.model === "gpt-image-2" || !request.model)) {
      rawModel = {
        apiModelName: "gpt-image-2",
        provider: "customOpenai",
        capabilities: {
          inputCapabilities: { text: true },
          outputCapabilities: {
            image: { aspectRatios: ["1:1"] }
          }
        }
      };
    }

    if (!rawModel) {
      sendJson(res, 400, {
        error: {
          message: `Unsupported model: ${request.model}. Supported: ${Object.keys(modelsConfig).join(", ")}`,
          type: "unsupported_model",
        },
      });
      console.log(`${getBeijingTimestamp()} [POST] /v1/images/generations | Model: ${request.model} | Status: 400 | Error: Unsupported model`);
      client.markFinished();
      return;
    }

    const model = {
      ...rawModel,
      id: request.model || "gpt-image-2",
      inputCapabilities: Object.keys(rawModel.capabilities?.inputCapabilities || {}).sort(),
      outputCapabilities: Object.keys(rawModel.capabilities?.outputCapabilities || {}).sort(),
    };
    logReceivedRequest("/v1/images/generations", request, model, prompt);

    const arenaBody = buildArenaBody({ model, prompt, request });
    const completed = await runArenaModelsTestWithContinuations({
      body: arenaBody,
      maxContinuations: 1,
      contextChars: 12000,
      autoContinue: false,
      signal: client.signal,
    });

    if (client.signal.aborted) return;

    if (completed.error) {
      sendJson(res, 500, {
        error: {
          message: String(completed.error),
          type: "arena_upstream_fetch_error",
        },
      });
      logResponse("/v1/images/generations", request, model.id, prompt, 500, { error: String(completed.error) });
      client.markFinished();
      return;
    }

    if (!completed.image) {
      sendJson(res, 500, {
        error: {
          message: "No image generated by upstream",
          type: "arena_upstream_error",
        },
      });
      logResponse("/v1/images/generations", request, model.id, prompt, 500, { error: "No image generated" });
      client.markFinished();
      return;
    }

    const imageBase64 = completed.image;
    const responseFormat = request.response_format || "url";
    const resObj = {
      created: Math.floor(Date.now() / 1000),
      data: [],
    };

    if (responseFormat === "b64_json") {
      resObj.data.push({ b64_json: imageBase64 });
    } else {
      try {
        const imageUrl = saveImageAndGetUrl(imageBase64, req.headers.host);
        resObj.data.push({ url: imageUrl });
      } catch (writeErr) {
        sendJson(res, 500, {
          error: {
            message: `Failed to save generated image: ${writeErr.message}`,
            type: "internal_error",
          },
        });
        logResponse("/v1/images/generations", request, model.id, prompt, 500, { error: `Save failed ${writeErr.message}` });
        client.markFinished();
        return;
      }
    }

    sendJson(res, 200, resObj);
    logResponse("/v1/images/generations", request, model.id, prompt, 200);
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isPublicGet = req.method === "GET" && (
      url.pathname.startsWith("/images/") ||
      url.pathname === "/favicon.ico" ||
      url.pathname === "/health"
    );

    if (!isPublicGet && !checkClientAuth(req)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "invalid_api_key" } });
      if (req.method === "POST") {
        console.log(`${getBeijingTimestamp()} [POST] ${url.pathname} | Status: 401 | Error: Unauthorized`);
      } else {
        console.log(`${getBeijingTimestamp()} [GET] ${url.pathname} | Status: 401`);
      }
      return;
    }
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
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      await handleImagesGenerations(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/images/")) {
      await handleServeImage(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    if (req.method === "POST") {
      console.log(`${getBeijingTimestamp()} [POST] ${url.pathname} | Status: 404 | Error: Path not found`);
    } else {
      console.log(`${getBeijingTimestamp()} [GET] ${url.pathname} | Status: 404`);
    }
  } catch (err) {
    if (isAbortError(err) || !responseWritable(res)) return;
    sendJson(res, 500, {
      error: {
        message: err?.message || String(err),
        type: "bridge_error",
      },
    });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST") {
      console.log(`${getBeijingTimestamp()} [POST] ${url.pathname} | Status: 500 | Error: ${err?.message || String(err)}`);
    } else {
      console.log(`${getBeijingTimestamp()} [GET] ${url.pathname} | Status: 500`);
    }
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
