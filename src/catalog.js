import { ARENA_HOME } from "./config.js";
import { readFileSync } from "node:fs";

const modelsJsonUrl = new URL("../models.json", import.meta.url);
const modelsData = JSON.parse(readFileSync(modelsJsonUrl, "utf8"));

let catalogCache = null;

function extractInitialModels(html) {
  const idx = html.indexOf("initialModels");
  if (idx === -1) {
    throw new Error("initialModels array not found in Arena HTML");
  }

  const start = html.indexOf("[", idx);
  if (start === -1) {
    throw new Error("initialModels key found, but array start was not found");
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("initialModels array did not close");
  }

  const raw = html.slice(start, end);
  const json = raw.includes('\\"') ? raw.replace(/\\"/g, '"') : raw;
  return JSON.parse(json);
}

function capKeys(capabilities, direction) {
  return Object.keys(capabilities?.[direction] || {}).sort();
}

function withDefaultInferenceSettings(model, settings) {
  return {
    ...model,
    modelsTestDefaultInferenceSettings: {
      ...(model.modelsTestDefaultInferenceSettings || {}),
      ...settings,
    },
  };
}

function toCandidate(model) {
  const inputCapabilities = capKeys(model.capabilities, "inputCapabilities");
  const outputCapabilities = capKeys(model.capabilities, "outputCapabilities");
  const provider = model.provider || null;
  const apiModelName = model.name || null;

  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.organization || "arena",
    provider,
    apiModelName,
    modelsTestApiModelName: apiModelName,
    publicName: model.publicName || null,
    displayName: model.displayName || model.publicName || apiModelName,
    userSelectable: model.userSelectable === true,
    arenaModelId: model.id,
    capabilities: model.capabilities,
    inputCapabilities,
    outputCapabilities,
    rankByModality: model.rankByModality || {},
    rank: model.rank ?? null,
    catalogStatus: model.catalogStatus || "catalog",
    discoveredByModelsTest: model.discoveredByModelsTest === true,
    evidenceArtifact: model.evidenceArtifact || null,
    modelsTestDefaultInferenceSettings: model.modelsTestDefaultInferenceSettings || null,
    theoreticalCallable: Boolean(provider && apiModelName && model.capabilities),
  };
}

function withDiscoveredModels(models) {
  const existing = new Set(models.map((m) => `${m.provider}/${m.apiModelName}`));
  const discovered = modelsData.discovered || [];
  return [
    ...models,
    ...discovered.filter((m) => !existing.has(`${m.provider}/${m.name}`)).map(toCandidate),
  ];
}

function withModelsTestAlias(model) {
  if (
    model?.provider === "googleWithThoughtSignatures" &&
    model.apiModelName === "ajax-20260517"
  ) {
    return {
      ...model,
      modelsTestApiModelName: "gemini-3.5-flash",
      modelsTestAliasReason:
        "Arena catalog exposes this Google experiment as ajax-20260517, but /nextjs-api/models/test completes inference through the actual googleWithThoughtSignatures/gemini-3.5-flash selector.",
    };
  }
  if (
    model?.provider === "googleVertexAnthropic" &&
    typeof model.apiModelName === "string"
  ) {
    const legacyOpusAliases = new Map([
      ["claude-opus-4-5-20251101-vertex", "claude-opus-4-5@20251101"],
      ["claude-opus-4-5-20251101-thinking-32k", "claude-opus-4-5@20251101"],
      ["claude-opus-4-1-20250805", "claude-opus-4-1@20250805"],
      ["claude-opus-4-1-20250805-thinking-16k", "claude-opus-4-1@20250805"],
      ["claude-opus-4-20250514", "claude-opus-4@20250514"],
      ["claude-opus-4-20250514-thinking-16k", "claude-opus-4@20250514"],
    ]);
    const alias = legacyOpusAliases.get(model.apiModelName);
    if (alias) {
      return {
        ...model,
        modelsTestApiModelName: alias,
        modelsTestAliasReason:
          "Arena /nextjs-api/models/test accepts legacy Google Vertex Anthropic Opus provider pools with Vertex '@date' model names, not the catalog hyphenated date/thinking label.",
      };
    }
  }
  if (
    model?.provider === "googleVertexAnthropic" &&
    typeof model.apiModelName === "string" &&
    model.apiModelName.endsWith("-vertex")
  ) {
    const aliased = {
      ...model,
      modelsTestApiModelName: model.apiModelName.slice(0, -"-vertex".length),
      modelsTestAliasReason:
        "Arena /nextjs-api/models/test accepts the Google Vertex Anthropic pool name without the catalog '-vertex' suffix.",
    };
    if (
      ["claude-opus-4-7-vertex", "claude-opus-4-8-vertex", "claude-sonnet-4-6-vertex"].includes(
        model.apiModelName,
      )
    ) {
      return withDefaultInferenceSettings(aliased, { temperature: 1 });
    }
    return aliased;
  }
  if (
    model?.provider === "googleVertexAnthropicAdaptive" &&
    typeof model.apiModelName === "string" &&
    model.apiModelName.endsWith("-thinking")
  ) {
    const aliased = {
      ...model,
      modelsTestApiModelName: model.apiModelName.slice(0, -"-thinking".length),
      modelsTestAliasReason:
        "Arena /nextjs-api/models/test accepts the Google Vertex Anthropic Adaptive pool name without the catalog '-thinking' suffix.",
    };
    if (["claude-opus-4-7-thinking", "claude-opus-4-8-thinking"].includes(model.apiModelName)) {
      return withDefaultInferenceSettings(aliased, { temperature: 1 });
    }
    return aliased;
  }
  if (model?.provider === "openaiResponses" && model.apiModelName === "gpt-5.5-high") {
    return {
      ...model,
      modelsTestApiModelName: "gpt-5.5",
      modelsTestDefaultInferenceSettings: { reasoningEffort: "high" },
      modelsTestAliasReason:
        "Arena /nextjs-api/models/test rejects 'gpt-5.5-high' as a model name; the verified path is base gpt-5.5 plus inferenceSettings.reasoningEffort=high.",
    };
  }
  if (model?.provider === "openaiResponses" && model.apiModelName === "gpt-5.5-xhigh") {
    return {
      ...model,
      modelsTestApiModelName: "gpt-5.5",
      modelsTestDefaultInferenceSettings: { reasoningEffort: "xhigh" },
      modelsTestAliasReason:
        "Arena /nextjs-api/models/test rejects 'gpt-5.5-xhigh' as a model name; the verified path is base gpt-5.5 plus inferenceSettings.reasoningEffort=xhigh.",
    };
  }
  if (
    (model?.provider === "openaiResponses" || model?.provider === "openaiResponsesWithPhase") &&
    (model.apiModelName === "iris-alpha-high" || model.apiModelName === "iris-alpha-xhigh")
  ) {
    const effort = model.apiModelName.endsWith("-xhigh") ? "xhigh" : "high";
    return {
      ...model,
      modelsTestApiModelName: "iris-alpha",
      modelsTestDefaultInferenceSettings: { reasoningEffort: effort },
      modelsTestAliasReason:
        `Arena /nextjs-api/models/test rejects '${model.apiModelName}' as a literal model name; the bridge exposes it as a virtual alias for base iris-alpha plus inferenceSettings.reasoningEffort=${effort}. The route also accepts invalid effort strings, so this proves accepted field plumbing rather than enforced upstream reasoning tier.`,
    };
  }
  if (model?.provider === "deepseek" && model.apiModelName === "deepseek-v4-flash") {
    return {
      ...model,
      discoveredByModelsTest: true,
      evidenceArtifact:
        model.evidenceArtifact ||
        "_audit/02_tracker/lead_artifacts/L-027_nextjs-models-test-hidden-invocation/logs/2026-06-01T23-13-51.219Z-arena-abt-candidate-enumeration.json",
    };
  }
  if (model?.provider === "deepseek" && model.apiModelName === "deepseek-v4-pro-public") {
    return {
      ...model,
      modelsTestApiModelName: "deepseek-v4-pro",
      discoveredByModelsTest: true,
      evidenceArtifact:
        model.evidenceArtifact ||
        "_audit/02_tracker/lead_artifacts/L-027_nextjs-models-test-hidden-invocation/logs/2026-06-01T23-13-51.219Z-arena-abt-candidate-enumeration.json",
      modelsTestAliasReason:
        "Arena catalog exposes the public row as deepseek-v4-pro-public, but /nextjs-api/models/test completes through deepseek/deepseek-v4-pro.",
    };
  }
  if (
    model?.provider === "deepseekToolCalling" &&
    model.apiModelName === "deepseek-v4-pro-thinking-public"
  ) {
    return {
      ...model,
      modelsTestApiModelName: "deepseek-v4-pro",
      discoveredByModelsTest: true,
      evidenceArtifact:
        model.evidenceArtifact ||
        "_audit/02_tracker/lead_artifacts/L-027_nextjs-models-test-hidden-invocation/logs/2026-06-01T23-13-51.219Z-arena-abt-candidate-enumeration.json",
      modelsTestAliasReason:
        "Arena catalog exposes the tool-calling row as deepseek-v4-pro-thinking-public, but /nextjs-api/models/test accepts deepseekToolCalling/deepseek-v4-pro.",
    };
  }
  if (
    model?.provider === "deepseekToolCalling" &&
    model.apiModelName === "deepseek-v4-flash-thinking"
  ) {
    return {
      ...model,
      modelsTestApiModelName: "deepseek-v4-flash",
      discoveredByModelsTest: true,
      evidenceArtifact:
        model.evidenceArtifact ||
        "_audit/02_tracker/lead_artifacts/L-027_nextjs-models-test-hidden-invocation/logs/2026-06-01T23-13-51.219Z-arena-abt-candidate-enumeration.json",
      modelsTestAliasReason:
        "Arena catalog exposes the tool-calling row as deepseek-v4-flash-thinking, but /nextjs-api/models/test accepts deepseekToolCalling/deepseek-v4-flash.",
    };
  }
  return model;
}

const VERIFIED_MODELS_TEST_SELECTORS = new Set(modelsData.verified || []);

export function isVerifiedModelsTestModel(model) {
  const normalized = withModelsTestAlias(model);
  const selector = `${normalized.modelsTestProvider || normalized.provider}/${normalized.modelsTestApiModelName || normalized.apiModelName}`;
  return normalized.discoveredByModelsTest === true || VERIFIED_MODELS_TEST_SELECTORS.has(selector);
}

export async function loadArenaCatalog({ refresh = false, signal } = {}) {
  if (catalogCache && !refresh) return catalogCache;

  const res = await fetch(ARENA_HOME, {
    signal,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "LMArenaBridge catalog fetch",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Arena catalog fetch failed: ${res.status}`);
  }
  const html = await res.text();
  const deployIds = [...new Set([...html.matchAll(/dpl_[A-Za-z0-9]+/g)].map((m) => m[0]))];
  const models = withDiscoveredModels(extractInitialModels(html).map(toCandidate));
  const callable = models.filter((m) => m.theoreticalCallable);
  const hiddenCallable = callable.filter((m) => !m.userSelectable);
  const discoveredOffCatalog = callable.filter((m) => m.discoveredByModelsTest);

  catalogCache = {
    fetchedAt: new Date().toISOString(),
    source: ARENA_HOME,
    deployIds,
    counts: {
      totalCatalogModels: models.length,
      theoreticalCallable: callable.length,
      publicSelectableCallable: callable.filter((m) => m.userSelectable).length,
      hiddenNonSelectableCallable: hiddenCallable.length,
      discoveredOffCatalogCallable: discoveredOffCatalog.length,
      excludedMissingProviderOrName: models.length - callable.length,
    },
    models,
    callable,
    hiddenCallable,
  };
  return catalogCache;
}

export function resolveModel(catalog, requested) {
  if (!requested || typeof requested !== "string") {
    throw new Error("model is required");
  }

  const [maybeProvider, ...rest] = requested.split("/");
  const maybeName = rest.join("/");
  if (maybeProvider && maybeName) {
    const exact = catalog.callable.find(
      (m) => m.provider === maybeProvider && m.apiModelName === maybeName,
    );
    if (exact) return withModelsTestAlias(exact);

    const googleVertexAlias = catalog.callable.find(
      (m) =>
        m.provider === maybeProvider &&
        maybeProvider === "googleVertexAnthropic" &&
        m.apiModelName === `${maybeName}-vertex`,
    );
    if (googleVertexAlias) {
      return {
        ...withModelsTestAlias(googleVertexAlias),
        modelsTestAliasReason:
          "Requested provider/name matches the Arena /nextjs-api/models/test Google Vertex Anthropic pool alias.",
      };
    }

    const googleVertexAdaptiveAlias = catalog.callable.find(
      (m) =>
        m.provider === maybeProvider &&
        maybeProvider === "googleVertexAnthropicAdaptive" &&
        m.apiModelName === `${maybeName}-thinking`,
    );
    if (googleVertexAdaptiveAlias) {
      return {
        ...withModelsTestAlias(googleVertexAdaptiveAlias),
        modelsTestAliasReason:
          "Requested provider/name matches the Arena /nextjs-api/models/test Google Vertex Anthropic Adaptive pool alias.",
      };
    }

    const modelsTestAlias = catalog.callable
      .map(withModelsTestAlias)
      .find(
        (m) =>
          (m.modelsTestProvider || m.provider) === maybeProvider &&
          (m.modelsTestApiModelName || m.apiModelName) === maybeName,
      );
    if (modelsTestAlias) return modelsTestAlias;
  }

  const apiNameMatches = catalog.callable.filter((m) => m.apiModelName === requested);
  if (apiNameMatches.length === 1) return withModelsTestAlias(apiNameMatches[0]);
  if (apiNameMatches.length > 1) {
    throw new Error(
      `ambiguous model '${requested}', use provider/apiModelName such as ${apiNameMatches[0].provider}/${apiNameMatches[0].apiModelName}`,
    );
  }

  const idMatches = catalog.callable.filter((m) => m.id === requested);
  if (idMatches.length === 1) return withModelsTestAlias(idMatches[0]);

  const publicNameMatches = catalog.callable.filter((m) => m.publicName === requested);
  if (publicNameMatches.length === 1) return withModelsTestAlias(publicNameMatches[0]);
  if (publicNameMatches.length > 1) {
    const textMatch = publicNameMatches.find((m) => m.outputCapabilities.includes("text"));
    if (textMatch) return withModelsTestAlias(textMatch);
    throw new Error(
      `ambiguous model '${requested}', use provider/apiModelName such as ${publicNameMatches[0].provider}/${publicNameMatches[0].apiModelName}`,
    );
  }
  throw new Error(`model '${requested}' not found in callable Arena catalog`);
}

export function toOpenAIModel(model) {
  const normalized = withModelsTestAlias(model);
  const catalogModelId = `${normalized.provider}/${normalized.apiModelName}`;
  const modelsTestProvider = normalized.modelsTestProvider || normalized.provider;
  const modelsTestSelector = `${modelsTestProvider}/${normalized.modelsTestApiModelName || normalized.apiModelName}`;
  return {
    id: catalogModelId,
    object: "model",
    created: 0,
    owned_by: normalized.owned_by,
    arena_model_id: normalized.arenaModelId,
    catalog_model_id: catalogModelId,
    arena_models_test_selector: modelsTestSelector,
    api_model_name: normalized.modelsTestApiModelName || normalized.apiModelName,
    catalog_api_model_name: normalized.apiModelName,
    arena_models_test_api_model_name:
      normalized.modelsTestApiModelName || normalized.apiModelName,
    arena_models_test_provider: modelsTestProvider,
    arena_models_test_default_inference_settings:
      normalized.modelsTestDefaultInferenceSettings || null,
    arena_models_test_alias_reason: normalized.modelsTestAliasReason || null,
    provider: normalized.provider,
    public_name: normalized.publicName,
    display_name: normalized.displayName,
    user_selectable: normalized.userSelectable,
    catalog_status: normalized.catalogStatus,
    discovered_by_models_test: normalized.discoveredByModelsTest,
    evidence_artifact: normalized.evidenceArtifact,
    theoretical_callable: normalized.theoreticalCallable,
    input_capabilities: normalized.inputCapabilities,
    output_capabilities: normalized.outputCapabilities,
  };
}
