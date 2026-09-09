import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  describeTokenShape,
  fetchQoderAccount,
  type QoderProviderOptions,
  resolveQoderCredentials,
} from "./auth.js";
import { QODER_VERSION, REFRESH_SKEW_MS } from "./constants.js";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";
import {
  catalogCachePath,
  catalogModels,
  catalogStatus,
  type DiscoveredModel,
  discoveryDisabled,
  displayName,
  getModelDefinition,
} from "./model-catalog.js";
import { fetchQuotaUsage, type QuotaUsage, setQuotaExhausted } from "./quota.js";
import { QODER_MODELS, STATIC_MODELS_ORIGIN } from "./static-models.js";

// Read-only capability layer.
//
// Everything a user can ASK about their Qoder account lives here, in one module,
// and index.ts only adapts these to opencode's Hooks.tool surface. The point is
// single-ownership: when upstream renames a field, moves a model into a
// `frontier` group, or changes what `cap: -1` means, this file changes and the
// skill text does not. A shell script that re-implemented the same endpoints is
// how that knowledge ended up duplicated once already -- see the notes on
// QUOTA_BUCKETS in quota.ts for the drift it causes.
//
// Every report returns the same shape:
//   output -- text handed to the model; already human-readable, no re-formatting
//   data   -- structured payload for anything that wants to compute on it
//
// Nothing here throws on a degraded answer. A missing optional lookup says so in
// its own line and the rest of the report still stands; only a failure of the
// thing that was actually asked about propagates, so the tool reports a real
// error rather than a confident-looking empty table.

export type CapabilityReport = { output: string; data: unknown };

// --- shared formatting ------------------------------------------------------

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// UTC, minute precision, no locale dependence -- renderers are asserted in tests
// and a machine's TZ must not change what they print.
export function formatUtc(ms: number | null): string {
  if (ms === null) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

// --- credential funnel for tools -------------------------------------------

// The tool surface runs in the legacy plugin instance, which sees the plugin's
// own options but NOT the credential opencode resolved through auth.loader or a
// `/connect` record. Those reach this instance over the globalThis channel the
// legacy config hook publishes to, and -- last -- from opencode's own store on
// disk.
//
// This ordering is deliberately NOT folded into resolveQoderCredentials(): the
// discovery path must keep exactly the precedence documented in auth.ts, where
// opencode hands the credential over itself. Reading the store off disk is a
// tool-only fallback so that `/connect qoder` users can ask about their quota at
// all; discovery is unaffected by it.
function toolOptions(explicit?: QoderProviderOptions): QoderProviderOptions {
  const shared = readSharedApiKey();
  const stored = shared ? "" : readStoredQoderToken();
  const apiKey = explicit?.apiKey || shared || stored;
  return {
    ...explicit,
    ...(apiKey ? { apiKey } : {}),
  };
}

function readSharedApiKey(): string {
  const value = (globalThis as Record<string, unknown>).__opencode_qoder_api_key;
  return typeof value === "string" && value.length > 0 ? value : "";
}

type StoredCredential = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
};

// opencode's own credential store. Best-effort and read-only: a missing file, a
// different install layout, or a corrupt JSON all collapse to "" and the report
// says the credential is absent rather than guessing.
function readStoredQoderToken(): string {
  try {
    const file = join(homedir(), ".local", "share", "opencode", "auth.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { qoder?: StoredCredential };
    const entry = parsed.qoder;
    if (!entry) return "";
    return text(entry.key) || text(entry.access);
  } catch {
    return "";
  }
}

// --- quota ------------------------------------------------------------------

function renderBuckets(usage: QuotaUsage): string[] {
  const lines: string[] = [];
  for (const bucket of usage.buckets) {
    if (!bucket.present) continue;
    const left = bucket.remaining ?? "?";
    if (bucket.unlimited) {
      lines.push(
        `  ${pad(bucket.label, 12)} ${left} left, no ceiling set${
          bucket.used !== null ? ` (${bucket.used} used)` : ""
        }`,
      );
      continue;
    }
    const pct = bucket.percentage !== null ? `, ${(bucket.percentage * 100).toFixed(1)}% used` : "";
    lines.push(`  ${pad(bucket.label, 12)} ${left} / ${bucket.ceiling ?? "?"} left${pct}`);
  }
  if (lines.length === 0) lines.push("  (response carried no quota buckets)");
  return lines;
}

export function renderQuota(usage: QuotaUsage, account?: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = text(account?.name);
  const email = text(account?.email);
  if (name || email)
    lines.push(`Account:  ${[name, email && `<${email}>`].filter(Boolean).join(" ")}`);
  const org = text(account?.organization_name);
  if (org) lines.push(`Org:      ${org}`);
  lines.push(`Plan:     ${usage.userType || "?"}${usage.usageType ? ` / ${usage.usageType}` : ""}`);
  lines.push("");
  lines.push("Credits:");
  lines.push(...renderBuckets(usage));
  lines.push("");
  lines.push(`Total left: ${usage.remainingTotal}${usage.exhausted ? "  -- EXHAUSTED" : ""}`);
  if (usage.planUsagePercentage !== null) {
    // Fraction upstream (0.01 == 1%) and plan-only: never a verdict on its own.
    lines.push(`Plan usage: ${(usage.planUsagePercentage * 100).toFixed(1)}% (plan bucket only)`);
  }
  lines.push(`Renews:     ${formatUtc(usage.expiresAt)}`);
  if (usage.exhausted) lines.push(`Upgrade:    ${usage.upgradeUrl}`);
  return lines.join("\n");
}

/**
 * Live credit balance plus the identity it belongs to.
 *
 * Stamps the module's quota flag on success so displayName() renders the same
 * "Unavailable" suffix here that opencode's model picker shows. That is a write
 * to derived state, not to any endpoint -- and leaving it unstamped would let
 * this tool quote availability from a flag it never fetched.
 */
export async function reportQuota(explicit?: QoderProviderOptions): Promise<CapabilityReport> {
  const options = toolOptions(explicit);
  const credentials = await resolveQoderCredentials(options);
  const usage = await fetchQuotaUsage(options);
  setQuotaExhausted(usage.exhausted);
  const account = await fetchQoderAccount(credentials.access);
  return { output: renderQuota(usage, account), data: usage };
}

// --- account ----------------------------------------------------------------

export function renderAccount(
  account: Record<string, unknown>,
  userID: string,
  userType: string,
): string {
  if (Object.keys(account).length === 0) {
    // The identity endpoint is not on the chat path, so a failure here is usually
    // a permission or region thing rather than a bad token. Say what IS known.
    return [
      "Account info unavailable: /api/v1/userinfo returned no record.",
      `Fallback identity from the credential: ${userID || "unknown"}` +
        `${userType ? ` (${userType})` : ""}`,
    ].join("\n");
  }
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    const s = text(value);
    if (s) lines.push(`${pad(label, 14)}${s}`);
  };
  push("Name", account.name);
  push("Username", account.username);
  push("Email", account.email);
  push("User ID", account.id);
  push("Org", account.organization_name);
  push("Org ID", account.organization_id);
  push("Registered", account.created_at);
  push("Signed up via", account.source);
  // A real boolean upstream. text() would collapse false to "" and print "no"
  // for every account, including one that is at the top tier.
  if (typeof account.is_highest_tier === "boolean") {
    lines.push(`${pad("Highest tier", 14)}${account.is_highest_tier ? "yes" : "no"}`);
  }
  push("Avatar", account.avatar);
  return lines.join("\n");
}

/** Who the token belongs to. Quota lives on the same credential, so it rides along. */
export async function reportAccount(explicit?: QoderProviderOptions): Promise<CapabilityReport> {
  const options = toolOptions(explicit);
  const credentials = await resolveQoderCredentials(options);
  const account = await fetchQoderAccount(credentials.access);
  let userType = "";
  try {
    userType = (await fetchQuotaUsage(options)).userType;
  } catch (error) {
    // Identity answer stands; the plan line just says it could not read the tier.
    logPlugin(`account: plan lookup failed (${errorMessage(error)})`);
  }
  return {
    output: renderAccount(account, credentials.userID, userType),
    data: { account, credentialUserID: credentials.userID, email: credentials.email },
  };
}

// --- models -----------------------------------------------------------------

function modelLine(model: DiscoveredModel): string {
  // displayName() is the only place the multiplier and the exhausted marker are
  // spelled; the picker shows the same string, so the tool must not invent its own.
  const efforts = (model.efforts ?? []).join("/") || "-";
  const factor =
    typeof model.priceFactor === "number" ? pad(`${model.priceFactor}x`, 7) : pad("", 7);
  return `  ${pad(model.id, 18)} ${factor}${pad(`ctx ${model.contextWindow}`, 14)}${pad(
    `in ${model.inputWindow ?? model.contextWindow}`,
    13,
  )}out ${model.maxTokens}  effort:${efforts}  ${model.reasoning ? "reasoning" : ""}`;
}

export function renderModels(models: DiscoveredModel[], status: ReturnType<typeof catalogStatus>) {
  const lines: string[] = [];
  lines.push(
    `Catalog: ${status.total} models (source=${status.source}, live=${status.live}, ` +
      `fetched ${formatUtc(status.fetchedAt)})`,
  );
  lines.push("");
  lines.push(
    `  ${pad("id", 18)} ${pad("factor", 7)}${pad("context", 14)}${pad("input", 13)}output`,
  );
  for (const model of models) lines.push(modelLine(model));
  lines.push("");
  lines.push("Query one with qoder_model {id}; names shown are the ids to pass as `qoder/<id>`.");
  return lines.join("\n");
}

/** Every model opencode is currently offering, with the limits it registered. */
export async function reportModels(explicit?: QoderProviderOptions): Promise<CapabilityReport> {
  const options = toolOptions(explicit);
  try {
    const usage = await fetchQuotaUsage(options);
    setQuotaExhausted(usage.exhausted);
  } catch (error) {
    // Availability suffixes then reflect the last known flag rather than live
    // truth. Worth saying: "all models look usable" is exactly what a failed
    // quota call leaves behind.
    logPlugin(`models: quota unavailable, availability may be stale (${errorMessage(error)})`);
  }
  const models = catalogModels();
  return {
    output: renderModels(models, catalogStatus()),
    data: { status: catalogStatus(), models: models.map((model) => ({ ...model })) },
  };
}

/** One model, resolved the way a request would resolve it (live, then bundled, then default). */
export function reportModel(id: string): CapabilityReport {
  const model = getModelDefinition(id);
  const status = catalogStatus();
  // getModelDefinition() falls through to a default for an unknown id and logs
  // it. The caller must be able to tell that apart from a real hit, because the
  // numbers it prints would otherwise look authoritative.
  const exact = model.id === id.trim();
  const lines = [
    exact ? `Model ${model.id}` : `Model ${id} not found -- resolved to ${model.id}`,
    ...renderModels([model], status).split("\n").slice(2),
  ];
  lines.push("");
  lines.push(`  name        ${displayName(model)}`);
  lines.push(`  input       ${(model.input ?? []).join(", ")}`);
  lines.push(`  reasoning   ${model.reasoning ? "yes" : "no"}`);
  lines.push(`  efforts     ${(model.efforts ?? []).join(", ") || "none"}`);
  lines.push(
    `  origin      ${model.origin ?? "?"} (catalog source=${status.source}${
      status.lastError ? `, lastError=${status.lastError}` : ""
    })`,
  );
  if (typeof model.priceFactor === "number") {
    lines.push(`  multiplier  ${model.priceFactor}x credits`);
  }
  if (!exact) {
    lines.push("");
    lines.push(
      `Nothing is registered under "${id.trim()}"; these are the limits of the fallback model.`,
    );
  }
  return { output: lines.join("\n"), data: { requested: id, resolved: model.id, model } };
}

// --- catalog diagnostics ----------------------------------------------------

export function renderCatalog(status: ReturnType<typeof catalogStatus>): string {
  const lines = [
    `source        ${status.source}`,
    `live models   ${status.live}`,
    `registered    ${status.total}`,
    // The legacy instance never stamps a TTL (only the v2 refresh cadence
    // does), so 0 here means "not tracked in this process", not the epoch.
    `fetched       ${formatUtc(status.fetchedAt || null)}`,
    `valid until   ${formatUtc(status.expiresAt || null)}`,
    `bundled table ${QODER_MODELS.length} entries (origin=${STATIC_MODELS_ORIGIN})`,
    `disk cache    ${catalogCachePath()}`,
    `discovery     ${discoveryDisabled() ? "DISABLED (QODER_DISABLE_MODEL_DISCOVERY)" : "on"}`,
    `client ver    ${QODER_VERSION} (pinned to qodercli's)`,
  ];
  if (status.lastError) lines.push(`last error    ${status.lastError}`);
  return lines.join("\n");
}

/**
 * Where the model list came from, and why. This is the answer to "why is model X
 * missing" -- the failure that used to require reading a log file.
 */
export function reportCatalog(): CapabilityReport {
  const status = catalogStatus();
  return {
    output: renderCatalog(status),
    data: {
      status,
      env: {
        QODER_DISABLE_MODEL_DISCOVERY: readEnv("QODER_DISABLE_MODEL_DISCOVERY"),
        QODER_MODEL_CACHE_SECONDS: readEnv("QODER_MODEL_CACHE_SECONDS"),
        QODER_MODEL_LIST_URL: readEnv("QODER_MODEL_LIST_URL"),
        QODER_STATIC_MODELS:
          describeTokenShape(readEnv("QODER_STATIC_MODELS")) === "absent" ? "unset" : "set",
      },
      staticOrigin: STATIC_MODELS_ORIGIN,
      cachePath: catalogCachePath(),
    },
  };
}

// --- auth -------------------------------------------------------------------

export function renderAuth(
  layers: Array<{ layer: string; shape: string }>,
  credentials: {
    userID: string;
    email: string;
    name: string;
    machineID: string;
    expires: number;
  } | null,
  error: string,
): string {
  const lines = ["Credential layers (highest first, shape only -- never the value):"];
  for (const entry of layers) {
    lines.push(`  ${pad(entry.layer, 34)}${entry.shape}`);
  }
  lines.push("");
  if (error) {
    lines.push(`Not authenticated: ${error}`);
    lines.push("Run `/connect qoder` in opencode, or set QODER_PERSONAL_ACCESS_TOKEN.");
    return lines.join("\n");
  }
  if (credentials) {
    lines.push(`Resolves to   ${credentials.name || "?"} <${credentials.email || "?"}>`);
    lines.push(`User ID       ${credentials.userID}`);
    lines.push(`Machine ID    ${credentials.machineID}`);
    // The plugin treats a token as dead this long before its real deadline, so
    // the number printed here is the one that governs behaviour, not the expiry.
    lines.push(
      `Usable until  ${formatUtc(credentials.expires + REFRESH_SKEW_MS)}` +
        ` (skew ${Math.round(REFRESH_SKEW_MS / 60000)}m)`,
    );
  }
  return lines.join("\n");
}

/**
 * Which credential this plugin instance actually sees, and what it resolves to.
 * Never prints a token: layers are reported by shape (`pat`, `opaque(27)`,
 * `absent`), which is what distinguishes "no credential reached the plugin" from
 * "an unresolved `{file:...}` reference did".
 */
export async function reportAuth(explicit?: QoderProviderOptions): Promise<CapabilityReport> {
  const options = toolOptions(explicit);
  const layers = [
    { layer: "personalAccessToken option", shape: describeTokenShape(options.personalAccessToken) },
    { layer: "apiKey option", shape: describeTokenShape(options.apiKey) },
    { layer: "shared channel (config hook)", shape: describeTokenShape(readSharedApiKey()) },
    { layer: "opencode auth.json", shape: describeTokenShape(readStoredQoderToken()) },
    {
      layer: "env QODER_PERSONAL_ACCESS_TOKEN",
      shape: describeTokenShape(readEnv("QODER_PERSONAL_ACCESS_TOKEN")),
    },
    { layer: "env QODER_PAT", shape: describeTokenShape(readEnv("QODER_PAT")) },
  ];
  try {
    const credentials = await resolveQoderCredentials(options);
    return {
      output: renderAuth(layers, credentials, ""),
      data: {
        layers,
        userID: credentials.userID,
        email: credentials.email,
        name: credentials.name,
        machineID: credentials.machineID,
        expires: credentials.expires,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    logPlugin(`auth: ${message}`);
    return { output: renderAuth(layers, null, message), data: { layers, error: message } };
  }
}

// --- error surface ----------------------------------------------------------

/**
 * Adapts a capability to a tool result without letting a throw reach the model
 * as a stack trace. The cause is kept -- a tool that answers "no data" with no
 * reason is indistinguishable from one that found nothing.
 */
export function capabilityError(name: string, error: unknown): CapabilityReport {
  const message = errorMessage(error).trim();
  logPlugin(`tool[${name}]: ${message}`);
  return {
    output: `qoder ${name} failed: ${message}`,
    data: { error: message },
  };
}
