import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QoderModelDefinition } from "./constants.js";
import { readEnv } from "./env.js";
import { opencodeConfigFile } from "./json-store.js";
import { logPlugin } from "./log.js";

// Bundled fallback model table, loaded at import time.
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
    // threshold from it (see QoderModelDefinition in constants.ts).
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
  const envPath = readEnv("QODER_STATIC_MODELS");
  if (envPath) candidates.push({ path: envPath, origin: `env ${envPath}` });
  candidates.push({
    path: opencodeConfigFile("qoder-models.json"),
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
