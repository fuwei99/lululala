import { readFileSync } from "node:fs";

function loadDotEnv() {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Optional local .env file.
  }
}

loadDotEnv();

function integerEnv(name, fallback, { min = 0 } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < min) return fallback;
  return value;
}

export const ARENA_HOME =
  process.env.LMARENA_HOME || "https://arena.ai/?mode=battle&chat-modality=chat";

export const ARENA_MODELS_TEST_ENDPOINT =
  process.env.LMARENA_MODELS_TEST_ENDPOINT ||
  "https://arena.ai/nextjs-api/models/test";

export const HOST = process.env.LMARENA_HOST || "0.0.0.0";
export const PORT = Number(process.env.LMARENA_PORT || "8787");
export const ENABLE_LIVE = process.env.LMARENA_ENABLE_LIVE === "1";
export const API_KEY = process.env.LMARENA_API_KEY || "";
export const AUTO_CONTINUE = process.env.LMARENA_AUTO_CONTINUE !== "0";
export const LATENCY_HINT = process.env.LMARENA_LATENCY_HINT !== "0";
export const LATENCY_HINT_TEXT =
  process.env.LMARENA_LATENCY_HINT_TEXT ||
  [
    "Latency-critical generation mode.",
    "The scoring target is earliest visible final-answer bytes, not hidden reasoning.",
    "Before the first token, do at most one private routing decision.",
    "Do not think step by step. Do not outline. Do not explain.",
    "Start now with the actual answer or artifact and keep writing it.",
    "For long answers that are not fully complete, append <<<LMARENA_CONTINUE>>> as the final line; the bridge removes this marker and continues automatically.",
  ].join(" ");
export const MAX_CONTINUATIONS = integerEnv("LMARENA_MAX_CONTINUATIONS", 12, { min: 0 });
export const CONTINUATION_CONTEXT_CHARS = integerEnv(
  "LMARENA_CONTINUATION_CONTEXT_CHARS",
  12000,
  { min: 1000 },
);
