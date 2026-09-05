import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logPlugin } from "./log.js";

export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_CENTER_URL = "https://center.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";

export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_QUOTA_URL = `${QODER_OPENAPI_URL}/api/v2/quota/usage`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;

export const QODER_PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
export const USER_AGENT = "opencode-qoder";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Bundled fallback table, loaded from models.json at startup.
//
// model-catalog.ts prefers the live list and only falls back to this table when
// discovery fails (no credentials, offline, upstream error, or a response shape
// we no longer understand). Keeping the numbers here accurate matters: a stale
// contextWindow silently regresses opencode's auto-compaction threshold, which
// is what made long Kimi sessions hit the gateway limit without ever compacting.
//
// The table is a plain JSON file rather than code so it can be fixed by hand
// without rebuilding. Read order, first readable wins:
//
//   1. $QODER_STATIC_MODELS, if set -- explicit override, mainly for testing;
//   2. ~/.config/opencode/qoder-models.json (honours XDG_CONFIG_HOME) -- user
//      edits survive plugin updates and reinstalls;
//   3. models.json shipped next to the compiled code -- the prefab that
//      regenerates from the live list on release.
//
// Every entry is validated (see isSaneStaticModel): a hand-edit with a typo
// drops that entry, not the whole table, and an unreadable file falls through
// to the next source instead of taking the plugin down.
//
// contextWindow = the DEFAULT context tier the gateway applies (the plugin sends
//                 no tier parameter, so advertising the largest tier is wrong).
// inputWindow   = the input budget within that tier; opencode derives the
//                 compaction threshold from this, so it must never exceed
//                 contextWindow.
export type QoderModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  supportsEffort: boolean;
  // Thinking-strength levels the gateway accepts for this model, from
  // thinking_config.enabled.efforts. Empty for models without a thinking_config.
  efforts?: string[];
  input: Array<"text" | "image">;
  contextWindow: number;
  // Input budget within the default tier. Defaults to contextWindow for the
  // bundled entries; discovery fills it from max_input_tokens / context_config.
  inputWindow?: number;
  maxTokens: number;
  // Credit multiplier Qoder bills for this model (qodercli: `price_factor`).
  // Rendered into the model name as "(0.5x)" -- see displayName() in
  // model-catalog.ts for why it cannot be a description field. Absent on the
  // bundled table: promotions move it, so only live discovery reports it.
  priceFactor?: number;
};

// Last-resort definition, compiled in: if every models.json source is missing
// or unreadable, the plugin still answers model-definition lookups instead of
// crashing. Keeps only what resolveQoderCredentials()/getModelDefinition()
// cannot do without.
const EMBEDDED_LAST_RESORT: QoderModelDefinition[] = [
  {
    id: "auto",
    name: "Auto",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
];

// A hand-edited entry must carry the numbers opencode acts on; anything else in
// the file is dropped entry-by-entry so one typo cannot blank the whole table.
// Exported for tests: this validator is the seam that a manual edit passes or
// fails on, and it should be checkable without touching the filesystem.
export function isSaneStaticModel(value: unknown): value is QoderModelDefinition {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  if (typeof model.id !== "string" || model.id === "") return false;
  if (typeof model.name !== "string" || model.name === "") return false;
  if (typeof model.reasoning !== "boolean" || typeof model.supportsEffort !== "boolean") {
    return false;
  }
  if (
    !Array.isArray(model.input) ||
    !model.input.every((kind) => kind === "text" || kind === "image")
  ) {
    return false;
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    const num = model[key];
    if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) return false;
  }
  if (model.inputWindow !== undefined) {
    const num = model.inputWindow;
    // Must never exceed contextWindow: opencode derives the compaction
    // threshold from it (see the type comment above).
    if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) return false;
    if ((num as number) > (model.contextWindow as number)) return false;
  }
  return true;
}

// Parses one candidate file. Returns undefined for garbage or for a file with
// no sane entries, which is how loadStaticModels() knows to fall through to the
// next source rather than trusting a broken hand-edit.
export function parseStaticModels(raw: string, origin: string): QoderModelDefinition[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // Accept a bare array or { "models": [...] } -- whatever is easier to hand-edit.
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : undefined;
  if (!entries) return undefined;
  const models = entries.filter(isSaneStaticModel);
  if (models.length === 0) return undefined;
  if (models.length !== entries.length) {
    logPlugin(
      `static-models: ${origin} dropped ${entries.length - models.length} invalid entr${entries.length - models.length === 1 ? "y" : "ies"}`,
    );
  }
  return models;
}

// Resolved once per process. origin labels the log line so a stale override is
// obvious when a hand-edit "does not take".
function loadStaticModels(): { models: QoderModelDefinition[]; origin: string } {
  const candidates: Array<{ path: string; origin: string }> = [];
  const envPath = String(process.env.QODER_STATIC_MODELS ?? "").trim();
  if (envPath) candidates.push({ path: envPath, origin: `env ${envPath}` });
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  candidates.push({
    path: join(configDir, "opencode", "qoder-models.json"),
    origin: "user override",
  });
  candidates.push({
    path: fileURLToPath(new URL("./models.json", import.meta.url)),
    origin: "shipped",
  });

  for (const { path, origin } of candidates) {
    try {
      const models = parseStaticModels(readFileSync(path, "utf8"), origin);
      if (models) {
        logPlugin(`static-models: ${models.length} entries from ${origin}`);
        return { models, origin };
      }
    } catch {
      // Missing or unreadable -- fall through to the next source.
    }
  }
  logPlugin("static-models: no readable file, using the compiled-in last resort");
  return { models: EMBEDDED_LAST_RESORT, origin: "embedded" };
}

// Read exactly once at import: two calls would read the disk twice and log the
// source line twice, and the two arrays would be different instances.
const staticModels = loadStaticModels();
export const STATIC_MODELS_ORIGIN = staticModels.origin;
export const QODER_MODELS: QoderModelDefinition[] = staticModels.models;

// When editing models.json by hand: only live data may move a contextWindow.
// Do not infer one from a successor model -- re-inferred values were empirically
// wrong once already (a retired preview id genuinely ran at 313,972 tokens, so
// copying its successor's 200,000 would have broken it). A dead id keeps
// whatever number was last observed live, or is dropped entirely.
