import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveQoderCredentials, type QoderProviderOptions } from "./auth.js";
import { QODER_MODELS, QODER_MODEL_LIST_URL, type QoderModelDefinition, USER_AGENT } from "./constants.js";
import { buildAuthHeaders } from "./cosy.js";

// Dynamic model discovery for Qoder.
//
// Mirrors qoder-bridge's model_catalog.go: fetch the live model list, cache it
// with a TTL, and fall back to the bundled QODER_MODELS table whenever the live
// list is unavailable (no credentials, offline, upstream error).
//
// Three tiers of data, best first:
//   "qoder"    -- live response from the model list endpoint
//   "cache"    -- last successful live response, persisted on disk. Survives a
//                 restart during an upstream outage, which the in-memory-only
//                 cache in qoder-bridge does not.
//   "fallback" -- the bundled QODER_MODELS table
//
// opencode only rebuilds its model catalog when a plugin calls
// ctx.catalog.reload(), so this module never touches the catalog itself. It just
// serves the current model table; index.ts compares signatures and reloads the
// catalog when that table actually changes.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // Go: defaultModelCatalogTTL = time.Hour
const ERROR_TTL_MS = 60 * 1000; // Go: defaultModelCatalogErrorTTL = time.Minute
const FETCH_TIMEOUT_MS = 15 * 1000; // Go: defaultModelCatalogTimeout = 15 * time.Second
const DEFAULT_MAX_TOKENS = 32768; // Go: DefaultMaxTok
const DEFAULT_CONTEXT_WINDOW = 131072; // Go: intField(entry, 131072, ...)
const DEFAULT_MODEL = "auto"; // Go: DefaultModel
const DISK_CACHE_VERSION = 1;
const DISK_CACHE_MAX_BYTES = 4 * 1024 * 1024;

// Guards against a renamed/repurposed upstream field silently feeding us garbage.
// A token budget above this is not a token budget (it is a byte count, a
// timestamp, ...), and trusting it would push opencode's compaction threshold so
// high that auto-compaction never runs.
const MAX_PLAUSIBLE_TOKENS = 100 * 1000 * 1000;

// Live/derived model definition: the bundled QoderModelDefinition plus the
// fields discovery adds. `efforts` drives the thinking-strength picker,
// `inputWindow` is the value opencode's compaction threshold actually uses.
export type DiscoveredModel = QoderModelDefinition & {
  efforts: string[];
  inputWindow: number;
  origin: "qoder" | "cache" | "static";
  source?: string;
  limitsFromUpstream?: boolean;
};

export type CatalogStatus = {
  source: "qoder" | "cache" | "fallback";
  live: number;
  total: number;
  fetchedAt: number;
  expiresAt: number;
  lastError: string;
};

type CatalogEntry = Record<string, unknown>;

let liveModels: DiscoveredModel[] = [];
const disabledIDs = new Set<string>();
let fetchedAt = 0;
let expiresAt = 0;
let source: CatalogStatus["source"] = "fallback";
let lastError = "";
let inflight: Promise<CatalogStatus> | undefined;

function envBool(name: string): boolean {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Go: modelDiscoveryDisabled() / QODER_DISABLE_MODEL_DISCOVERY
export function discoveryDisabled(): boolean {
  return envBool("QODER_DISABLE_MODEL_DISCOVERY");
}

// Go: qoderModelListURL() / QODER_MODEL_LIST_URL
function modelListURL(): string {
  const value = String(process.env.QODER_MODEL_LIST_URL ?? "").trim();
  return value || QODER_MODEL_LIST_URL;
}

// Go: modelCatalogTTL() / QODER_MODEL_CACHE_SECONDS
function cacheTTLMs(): number {
  const seconds = Number.parseInt(String(process.env.QODER_MODEL_CACHE_SECONDS ?? "").trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TTL_MS;
}

function diskCachePath(): string {
  const override = String(process.env.QODER_MODEL_DISK_CACHE ?? "").trim();
  if (override) return override;
  // Sits next to opencode's own models.dev cache.
  return join(homedir(), ".cache", "opencode", "opencode-qoder-models.json");
}

function isSaneModel(model: DiscoveredModel): boolean {
  return (
    Boolean(model) &&
    typeof model.id === "string" &&
    model.id !== "" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0 &&
    model.contextWindow <= MAX_PLAUSIBLE_TOKENS &&
    Number.isFinite(model.inputWindow) &&
    model.inputWindow > 0 &&
    model.inputWindow <= model.contextWindow &&
    Number.isFinite(model.maxTokens) &&
    model.maxTokens > 0 &&
    model.maxTokens <= MAX_PLAUSIBLE_TOKENS &&
    Array.isArray(model.input) &&
    model.input.length > 0
  );
}

// Persist the PARSED table rather than the raw response: a future upstream shape
// change then cannot invalidate what we already understood.
function saveDiskCache(models: DiscoveredModel[]): void {
  try {
    const file = diskCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: DISK_CACHE_VERSION, fetchedAt: Date.now(), models }), "utf8");
  } catch {
    // A read-only or missing cache directory must never break discovery.
  }
}

function loadDiskCache(): { models: DiscoveredModel[]; fetchedAt: number } | undefined {
  try {
    const file = diskCachePath();
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    if (raw.length === 0 || raw.length > DISK_CACHE_MAX_BYTES) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== DISK_CACHE_VERSION || !Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.filter(isSaneModel);
    // Require a meaningful table; a truncated or half-written file should not
    // displace the bundled fallback.
    if (models.length === 0) return undefined;
    return { models, fetchedAt: Number(parsed.fetchedAt) || 0 };
  } catch {
    return undefined;
  }
}

// Seed from disk at import time so the very first catalog build -- which happens
// before any network round trip -- already uses the last known good data instead
// of the bundled table.
const seeded = loadDiskCache();
if (seeded) {
  // Re-stamp origin: these were "qoder" when fetched, but right now they are a
  // persisted snapshot, and catalogStatus() should say so.
  liveModels = seeded.models.map((model) => ({ ...model, origin: "cache" as const }));
  fetchedAt = seeded.fetchedAt;
  source = "cache";
}

// Go: stringField()
function pickString(entry: CatalogEntry, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

// Go: boolField() -- returns undefined when the key is absent so callers can
// distinguish "not provided" from "explicitly false".
function pickBool(entry: CatalogEntry, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

// Go: intField()
function pickInt(entry: CatalogEntry, fallback: number, keys: string[]): number {
  for (const key of keys) {
    const value = entry[key];
    let parsed = Number.NaN;
    if (typeof value === "number" && Number.isFinite(value)) parsed = Math.floor(value);
    else if (typeof value === "string") parsed = Number.parseInt(value, 10);
    // Rejecting implausible magnitudes is what stops a renamed or repurposed
    // upstream field (a byte count, a millisecond timestamp) from silently
    // becoming a token budget and disabling auto-compaction.
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_PLAUSIBLE_TOKENS) return parsed;
  }
  return fallback;
}

// Qoder advertises several selectable context tiers per model, e.g.
//   context_config: { "1M": {token_count: 1000000},
//                     "200K": {token_count: 200000, is_default: true},
//                     "400K": {token_count: 400000} }
// The plugin sends no tier parameter, so the gateway applies the DEFAULT tier.
// Reporting the largest tier instead is what made opencode defer compaction
// until ~980k tokens while the gateway rejected the request at ~180k.
function defaultTierTokens(entry: CatalogEntry): number {
  const tiers = entry.context_config;
  if (!tiers || typeof tiers !== "object") return 0;
  let first = 0;
  for (const tier of Object.values(tiers as Record<string, any>)) {
    const tokens = Number(tier?.token_count);
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > MAX_PLAUSIBLE_TOKENS) continue;
    if (tier?.is_default === true) return Math.floor(tokens);
    if (first === 0) first = Math.floor(tokens);
  }
  return first;
}

// Qoder exposes reasoning effort levels through thinking_config, e.g.
// kmodel_latest -> { enabled: { efforts: { high:{}, low:{}, max:{} } } }.
function thinkingEfforts(entry: CatalogEntry): string[] {
  const efforts = (entry.thinking_config as any)?.enabled?.efforts;
  if (!efforts || typeof efforts !== "object") return [];
  return Object.keys(efforts);
}

// Go: modelDefinitionFromCatalogEntry()
function modelFromEntry(entry: CatalogEntry): DiscoveredModel | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const id = pickString(entry, ["key", "id", "model"]);
  if (!id) return undefined;
  const enabled = pickBool(entry, ["enable", "enabled"]);
  if (enabled === false) {
    disabledIDs.add(id);
    return undefined;
  }
  disabledIDs.delete(id);
  const isVL = pickBool(entry, ["is_vl", "isVL"]) ?? false;
  const declaredInput = pickInt(entry, 0, ["max_input_tokens", "context_window", "contextWindow"]);
  const tierTokens = defaultTierTokens(entry);
  const contextWindow = tierTokens || declaredInput || DEFAULT_CONTEXT_WINDOW;
  // `max_input_tokens` is NOT semantically consistent across Qoder models:
  //   kmodel_latest -> 180000, i.e. the input budget OF the default 200K tier
  //   ultimate      -> 1000000, i.e. the LARGEST selectable tier, while the
  //                    default tier is only 200K
  // opencode's compaction threshold prefers limit.input over limit.context
  // (Is() returns `limit.input - reserved` whenever limit.input is set), so
  // trusting 1000000 would put the threshold back at ~980k tokens while the
  // gateway rejects the request at the 200K default tier. Clamp to the tier
  // the gateway actually applies, since the plugin sends no tier parameter.
  const inputWindow = Math.min(declaredInput || contextWindow, contextWindow);
  const efforts = thinkingEfforts(entry);
  return {
    id,
    name: pickString(entry, ["display_name", "displayName", "name"]) || id,
    reasoning: pickBool(entry, ["is_reasoning", "isReasoning"]) ?? false,
    supportsEffort: efforts.length > 0,
    efforts,
    input: isVL ? ["text", "image"] : ["text"],
    contextWindow,
    inputWindow: inputWindow || contextWindow,
    maxTokens: pickInt(entry, DEFAULT_MAX_TOKENS, ["max_output_tokens", "max_tokens", "maxTokens"]),
    source: pickString(entry, ["source"]) || "system",
    origin: "qoder",
    // True only when at least one token budget came from a field we actually
    // recognise. parseCatalog() uses this to detect an upstream schema change:
    // ids would still parse, but every limit would silently fall back to
    // DEFAULT_CONTEXT_WINDOW -- plausible-looking numbers that are wrong.
    limitsFromUpstream: declaredInput > 0 || tierTokens > 0,
  };
}

function normalizeStatic(model: QoderModelDefinition): DiscoveredModel {
  return {
    ...model,
    // The bundled table may itself carry efforts (e.g. offline models that the
    // gateway still serves); keep them instead of hardcoding an empty list.
    efforts: model.efforts ?? [],
    inputWindow: model.inputWindow ?? model.contextWindow,
    origin: "static",
  };
}

// Go: parseQoderModelCatalog() -- only the `chat` group feeds agent_chat_generation.
export function parseCatalog(payload: unknown): DiscoveredModel[] {
  const entries = payload && typeof payload === "object" && Array.isArray((payload as any).chat)
    ? ((payload as any).chat as CatalogEntry[])
    : [];
  if (entries.length === 0) throw new Error("Qoder model list response is missing the chat array");
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const model = modelFromEntry(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new Error("Qoder model list returned no enabled chat models");
  // Schema-drift guard. The response parsed and still carries model ids, but not
  // one entry exposed a token budget we recognise -- meaning the limit fields
  // were renamed, moved, or restructured. Adopting it would give every model
  // DEFAULT_CONTEXT_WINDOW (131072), which looks perfectly reasonable while
  // being wrong, and would silently misplace opencode's compaction threshold.
  // Reject the batch instead and stay on the previous data (disk cache, then the
  // bundled table), which is at least known-good.
  if (!models.some((model) => model.limitsFromUpstream)) {
    throw new Error("Qoder model list carried no recognisable token limits (upstream schema change?)");
  }
  // Go: re-inject DefaultModel when upstream stopped advertising it.
  if (!seen.has(DEFAULT_MODEL)) {
    const fallback = QODER_MODELS.find((model) => model.id === DEFAULT_MODEL) ?? QODER_MODELS[0];
    models.unshift(normalizeStatic(fallback));
  }
  return models;
}

// Go: fetchLiveQoderModels()
async function fetchModels(options: QoderProviderOptions): Promise<DiscoveredModel[]> {
  const credentials = await resolveQoderCredentials(options);
  const url = modelListURL();
  const headers = buildAuthHeaders(null, url, {
    userID: credentials.userID,
    authToken: credentials.access,
    name: credentials.name,
    email: credentials.email,
    machineID: credentials.machineID,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Qoder model list returned ${response.status}: ${text.slice(0, 200)}`);
    }
    return parseCatalog(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

// Go: RefreshQoderModels(ctx, force)
export async function refreshModels(options: QoderProviderOptions = {}, force = false): Promise<CatalogStatus> {
  if (discoveryDisabled()) return catalogStatus();
  // expiresAt is stamped on BOTH success (TTL) and failure (error TTL), so this
  // single check throttles retries too. Go guards with `len(models) > 0` as
  // well, but its cache is seeded with the static table so that is always true;
  // here liveModels starts empty, and including it in the guard would make the
  // error TTL dead code -- a bad PAT would then re-hit the exchange endpoint on
  // every tick. Serving is unaffected either way: catalogModels() falls back to
  // the bundled table while source is not "qoder".
  if (!force && Date.now() < expiresAt) return catalogStatus();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const models = await fetchModels(options);
      liveModels = models;
      fetchedAt = Date.now();
      expiresAt = fetchedAt + cacheTTLMs();
      source = "qoder";
      lastError = "";
      // Persist so the NEXT process start begins from known-good data even if
      // the endpoint is down at that moment. Failures here are swallowed by
      // saveDiskCache(); a read-only cache dir must not break discovery.
      saveDiskCache(models);
    } catch (error) {
      // Keep serving whatever we had (live, then disk cache, then bundled);
      // retry sooner than the happy-path TTL.
      lastError = error instanceof Error ? error.message : String(error);
      expiresAt = Date.now() + ERROR_TTL_MS;
    } finally {
      inflight = undefined;
    }
    return catalogStatus();
  })();
  return inflight;
}

// The table index.ts registers into opencode's catalog.
//
// Models that vanished upstream are kept (after the live ones) so a session that
// is already running on such a model does not lose it mid-conversation -- the
// gateway still accepts those ids today. Models upstream explicitly disabled are
// NOT resurrected.
export function catalogModels(): DiscoveredModel[] {
  // "cache" (seeded from disk) must be honoured exactly like "qoder"; checking
  // only for "qoder" here would make the persisted snapshot dead weight and drop
  // every restart straight back to the bundled table.
  if ((source !== "qoder" && source !== "cache") || liveModels.length === 0) {
    return QODER_MODELS.map(normalizeStatic);
  }
  const seen = new Set(liveModels.map((model) => model.id));
  const legacy = QODER_MODELS.filter((model) => !seen.has(model.id) && !disabledIDs.has(model.id)).map(normalizeStatic);
  return [...liveModels, ...legacy];
}

// Go: GetModelDefinition() -- live, then the bundled table, then a sane default.
// constants.ts used to return QODER_MODELS[0] for unknown ids; that behaviour is
// preserved as the last resort.
export function getModelDefinition(modelID: string): DiscoveredModel {
  const id = String(modelID ?? "").trim();
  return catalogModels().find((model) => model.id === id) ?? normalizeStatic(QODER_MODELS[0]);
}

// Cheap equality check so index.ts only reloads opencode's catalog when the
// table actually changed, instead of on every timer tick.
export function catalogSignature(): string {
  return catalogModels()
    .map((model) =>
      [
        model.id,
        model.name,
        model.contextWindow,
        model.inputWindow,
        model.maxTokens,
        model.reasoning,
        model.supportsEffort,
        model.input.join("+"),
      ].join(":"),
    )
    .join("|");
}

export function catalogStatus(): CatalogStatus {
  return {
    source,
    live: liveModels.length,
    total: catalogModels().length,
    fetchedAt,
    expiresAt,
    lastError,
  };
}
