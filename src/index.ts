import { type Hooks, type PluginInput, type PluginOptions, tool } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  decodeOAuthRefresh,
  generatePKCE,
  pollDeviceFlow,
  type QoderProviderOptions,
  type StoredCredential,
  // Describes a credential without ever printing it -- auth.ts owns the rule, so
  // the tool surface reports exactly what the log lines report.
  describeTokenShape as tokenShape,
} from "./auth.js";
import {
  type CapabilityReport,
  capabilityError,
  reportAccount,
  reportAuth,
  reportCatalog,
  reportModel,
  reportModels,
  reportQuota,
} from "./capabilities.js";
import { nonEmptyString } from "./coerce.js";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  QODER_BASE_URL,
  QODER_MANAGE_URL,
  QODER_PAT_ENV,
  ZERO_COST,
} from "./constants.js";
import { getMachineId } from "./cosy.js";
import { createQoder, QoderLanguageModel } from "./language-model.js";
import { errorMessage, logPlugin } from "./log.js";
import {
  catalogModels,
  catalogSignature,
  catalogStatus,
  type DiscoveredModel,
  discoveryDisabled,
  displayName,
  isValidContextTier,
  refreshModels,
} from "./model-catalog.js";
import { maybeImportPATsFromEnv } from "./pat-import.js";
import { addPAT, getActivePAT, listPATs, removePAT, switchPAT } from "./pat-store.js";
import { getRoutingPolicy, type RoutingPolicy, updateRoutingPolicy } from "./routing-policy.js";
import { forgetSession, recordSessionParent, resolveRootSession } from "./session-roots.js";
import { publishSharedApiKey, readShared, readSharedApiKey, writeShared } from "./shared-state.js";
import {
  clearAllTiers,
  clearSessionTier,
  clearTier,
  getSelectedTier,
  getSessionTier,
  listSelectedTiers,
  setSessionTier,
  setTier,
} from "./tier-store.js";

export { createQoder, QoderLanguageModel };

type QoderPluginOptions = PluginOptions & {
  providerID?: string;
  setDefault?: boolean;
  apiKey?: string;
};

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Emitted from both registration paths, so the log shows where the names came
// from whichever opencode version is driving. `source` is the field that
// distinguishes a bundled fallback -- where no name carries a multiplier,
// because the static table has no priceFactor -- from live or cached data.
function logCatalogRegistration(path: "legacy" | "v2"): void {
  const status = catalogStatus();
  // pid tells whether the legacy and v2 hooks share a process -- if they do not,
  // anything captured in one is invisible to the other.
  logPlugin(
    `catalog[${path}]: pid=${process.pid} registered ${status.total} models ` +
      `(source=${status.source}, live=${status.live})`,
  );
}

// The "usable string" guard (coerce.ts) is shared by option and globalThis
// reads. (metadataString next to credentialToOptions deliberately keeps a
// weaker guard -- it returns "" as a real value -- so it is NOT folded in.)

function optionString(
  options: PluginOptions | undefined,
  key: keyof QoderPluginOptions,
): string | undefined {
  return nonEmptyString(options?.[key]);
}

// Cross-instance refresh trigger. The tier/pat tools live on the legacy
// instance, but only the v2 instance owns refreshCatalog() and
// ctx.catalog.reload(). setupV2 publishes its force-refresh closure here; the
// tools call it when present so a switch takes effect without waiting out the
// 15-minute refresh timer (whose non-forced path is also TTL-throttled).
const REFRESH_TRIGGER_KEY = "__opencode_qoder_refresh_trigger";

// Once-flag for the OPENCODE_QODER_PAT bootstrap import. opencode loads this
// plugin twice per process and neither realm sees the other's module state, so
// the flag lives on globalThis; addPAT's dedup makes a repeat idempotent, the
// flag only prevents a re-log.
const PAT_IMPORT_DONE_KEY = "__opencode_qoder_pat_import_done";

function triggerCatalogRefresh(): boolean {
  const trigger = readShared(REFRESH_TRIGGER_KEY);
  if (typeof trigger !== "function") return false;
  try {
    (trigger as () => void)();
    return true;
  } catch {
    return false;
  }
}

// Wired by setupV2 once refreshCatalog() exists, and invoked when a credential
// first becomes available -- so discovery starts immediately rather than waiting
// out the next 15-minute tick. Deferred rather than called directly because the
// capture site is registered before refreshCatalog is defined, and a closure
// over a not-yet-initialised const would throw.
let onCredentialsCaptured: (() => void) | undefined;

// Per instance, so the aisdk handler reports once rather than once per request.
let aisdkHandlerLogged = false;

function providerID(options?: PluginOptions): string {
  return optionString(options, "providerID") || PROVIDER_ID;
}

function shouldSetDefault(options?: PluginOptions): boolean {
  return options?.setDefault === true;
}

// The `limit` triple is identical on both config surfaces; only the v1 legacy
// path carried the explanation, so the comment now lives with the shape.
function modelLimit(model: DiscoveredModel): { context: number; input: number; output: number } {
  // A selected context tier overrides the default-tier limits, so opencode's
  // auto-compaction threshold defers past the default tier instead of
  // compacting at ~180k while the gateway would still accept input at the
  // selected tier. The selection was validated against the model's advertised
  // tiers at switch time; re-checked here because the live table may have
  // changed since (a tier the gateway stopped advertising must not keep
  // driving the registered limits).
  const tier = getSelectedTier(model.id);
  if (tier !== undefined && isValidContextTier(model, tier)) {
    return { context: tier, input: tier, output: model.maxTokens };
  }
  return {
    context: model.contextWindow,
    // opencode's auto-compaction threshold derives from limit.input, so it
    // must reflect the tier the gateway actually applies, not the largest one.
    input: model.inputWindow ?? model.contextWindow,
    output: model.maxTokens,
  };
}

function legacyModelConfig(model: DiscoveredModel) {
  const config: Record<string, unknown> = {
    // Carries the credit multiplier and the exhausted marker -- see
    // displayName(), which explains why it cannot be a description field.
    name: displayName(model),
    reasoning: model.reasoning,
    tool_call: true,
    attachment: model.input.includes("image"),
    cost: ZERO_COST,
    limit: modelLimit(model),
    modalities: {
      input: model.input,
      output: ["text"],
    },
  };
  // Thinking-strength picker.
  //
  // Declared as the v1 Record form ({ "<effort>": <body> }). opencode's config
  // schema keeps `variants` on plugin-supplied provider models but strips
  // `reasoning_options`, so the Record is the only one of the two that survives;
  // /config/providers then renders it straight through. That endpoint is what
  // Paseo reads to build its thinkingOptions list, so the body shape must match
  // what opencode itself generates for @ai-sdk/openai-compatible, namely
  // {reasoningEffort: value}.
  //
  // Deliberately does NOT touch `reasoning` above. That flag is dual-purpose: it
  // also feeds `model_config.is_reasoning` in the wire payload (language-model.ts).
  // It is not needed for the picker -- verified on opencode 1.18.27 that
  // kmodel_latest exposes high/low/max while capabilities.reasoning stays false --
  // so leaving it alone keeps the gateway request byte-identical to before.
  //
  // Efforts come from Qoder's live `thinking_config.enabled.efforts`, e.g.
  // kmodel_latest -> [high, low, max]. Models without a thinking_config keep an
  // empty {} and an unchanged payload.
  const efforts = model.efforts ?? [];
  if (efforts.length > 0) {
    config.variants = Object.fromEntries(
      efforts.map((effort) => [effort, { reasoningEffort: effort }]),
    );
  }
  return config;
}

// Minimal shapes for the parts of opencode's legacy plugin config that this
// plugin mutates. opencode's own config type is dynamically shaped, so we
// declare only what we rely on instead of reaching through `any`.
interface LegacyModelConfig {
  [key: string]: unknown;
}
interface LegacyProviderConfig {
  name?: string;
  env?: string[];
  npm?: string;
  options?: Record<string, unknown>;
  models?: Record<string, LegacyModelConfig>;
}
interface LegacyAgentConfig {
  model?: string;
  // Verified against opencode 1.18.29's agent Info schema: {model, variant,
  // temperature, top_p, prompt, description, mode, hidden, options, ...}.
  // There is no reasoningEffort field; per-request reasoning is delivered via
  // model `variant` instead, and lite publishes no variants at all.
  variant?: string;
}
interface LegacyConfig {
  provider?: Record<string, LegacyProviderConfig>;
  model?: string;
  // SINGULAR key -- this is the documented agent-definition section
  // (opencode config schema: agent.{plan,build,general,explore,title,summary,
  // compaction,...}). The plural `agents` key is NOT the same section: writing
  // agents.task there CREATES a ghost custom agent (mode "all") instead of
  // configuring a builtin, because "task"/"summarizer" ceased to exist as
  // builtins around the 1.x JS rewrite.
  agent?: Record<string, LegacyAgentConfig>;
  // Legacy/compat alias opencode still merges by name; respected below so a
  // user override under either spelling wins over our defaults.
  agents?: Record<string, LegacyAgentConfig>;
}

function applyLegacyConfig(cfg: LegacyConfig, options?: PluginOptions): void {
  const id = providerID(options);
  cfg.provider ??= {};
  if (!cfg.provider[id]) cfg.provider[id] = {};
  const current = cfg.provider[id];
  current.name ??= PROVIDER_NAME;
  current.env ??= [...QODER_PAT_ENV];
  current.npm ??= import.meta.url;
  current.options ??= {};
  // Pristine state, before this hook adds baseURL. The user's provider options
  // ARE visible here, and apiKey arrives already resolved from `{file:...}` into
  // a usable token -- this is the only place in the whole plugin that sees it.
  logPlugin(
    `legacy: pid=${process.pid} providerOptions=${JSON.stringify(Object.keys(current.options))} ` +
      `apiKey=${tokenShape(current.options.apiKey)}`,
  );
  current.options.baseURL ??= QODER_BASE_URL;
  const apiKey = optionString(options, "apiKey");
  if (apiKey && current.options.apiKey === undefined) current.options.apiKey = apiKey;
  // Captured after the assignment above so either source -- plugin options or
  // the user's provider config -- is picked up, then handed across to the v2
  // instance over globalThis, since module state does not reach it.
  {
    const configured = optionString(current.options, "apiKey");
    if (configured && publishSharedApiKey(configured)) {
      logPlugin(`legacy: published apiKey (${tokenShape(configured)}) for discovery`);
      // opencode substitutes `{file:...}` before this hook runs. If a future
      // version hands over the raw reference, discovery would send it as a
      // bearer token and fail; say so rather than leaving a 401 to be guessed at.
      if (configured.startsWith("{")) {
        logPlugin("legacy: published apiKey is an unresolved reference, not a token");
      }
    }
  }
  current.models ??= {};

  for (const model of catalogModels()) {
    current.models[model.id] = {
      ...legacyModelConfig(model),
      ...(current.models[model.id] ?? {}),
    };
  }

  if (shouldSetDefault(options) && !cfg.model) cfg.model = `${id}/auto`;
  logCatalogRegistration("legacy");

  // Configure subagents to use free/cheap models. This saves quota by using
  // lite (free, 200k) for mechanical tasks -- title generation, compaction,
  // plan research, parallel subtasks -- while the main agent keeps the user's
  // selected model.
  //
  // Resolution order in opencode 1.18.x (verified in the bundle):
  //   message.model ?? agent.config.model ?? session's current model
  // So an agent WITH a configured model is pinned to it (our goal); an agent
  // without one inherits whatever model the user picked. Only the main agent
  // follows the user's model picker; that is by design and is what keeps the
  // picker meaningful.
  //
  // Precedence for our defaults: an entry under cfg.agent.X or the legacy
  // cfg.agents.X alias means the user configured it -- not touched.
  //
  // Compaction caveat: the compaction agent receives the WHOLE conversation,
  // and lite caps at 200k. A conversation switched to a higher tier does NOT
  // strand it -- the routing policy (see routing-policy.ts) escalates that
  // request, like any non-exempt pinned-agent call, to a model advertising
  // the session tier (default target: the cheap qfmodel). Only with the policy
  // disabled would such a session fail to compact; the pin stays so the
  // common case remains free.
  if (!cfg.agent) cfg.agent = {};
  const agents = cfg.agent;
  const ensureAgent = (name: string, value: LegacyAgentConfig): void => {
    if (agents[name] || cfg.agents?.[name]) return;
    agents[name] = value;
  };

  // plan: explores code and writes plans, doesn't execute.
  ensureAgent("plan", { model: `${id}/lite` });
  // general/explore: Task-tool subagents (multi-step work / read-only search).
  // Subagent sessions start fresh, so 200k is plenty.
  ensureAgent("general", { model: `${id}/lite` });
  ensureAgent("explore", { model: `${id}/lite` });
  // title: generates session titles from the user prompts -- always small.
  ensureAgent("title", { model: `${id}/lite` });
  // compaction: compresses full conversations. Pinned to lite for quota; see
  // the caveat above for sessions exceeding 200k tokens.
  ensureAgent("compaction", { model: `${id}/lite` });
  // Deliberately untouched: build (main agent, user's model choice), summary
  // (hidden internal agent, safe to inherit the session model).

  logPlugin(
    `legacy: configured subagents (plan/general/explore/title/compaction -> ${id}/lite). ` +
      `Set agent.* in opencode.json to override.`,
  );
}

function v2ModelConfig(model: DiscoveredModel) {
  return {
    // ConfigV2.Model has no description field either, so the annotation rides
    // on name exactly as in the legacy path.
    name: displayName(model),
    family: model.id,
    api: {
      id: model.id,
      type: "aisdk" as const,
      // This MODEL-level api.package is what Provider.getLanguage actually
      // resolves. With "@ai-sdk/openai-compatible" there, opencode served
      // chat with its GENERIC client (verified 1.18.29: real request, zero
      // QoderLanguageModel wire-probe lines) and every payload rule in
      // language-model.ts was dead -- including context-tier injection.
      // A file:// package falls through the built-in map to
      // import(package) -> first `create*` export -> createQoder below.
      package: import.meta.url,
      url: QODER_BASE_URL,
      settings: {},
    },
    capabilities: {
      tools: true,
      input: model.input,
      output: ["text"],
    },
    // One variant per advertised thinking strength. v7 merges the selected
    // variant's body into request.body, and the aisdk bridge spreads
    // request.body into the QoderLanguageModel options, where
    // resolveReasoningEffort() picks it up.
    variants: (model.efforts ?? []).map((effort) => ({
      id: effort,
      headers: {},
      body: { reasoningEffort: effort },
    })),
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active" as const,
    // Models upstream explicitly disabled never enter catalogModels() (they are
    // filtered by disabledIDs), so everything registered here is enabled.
    enabled: true,
    limit: modelLimit(model),
  };
}

function metadataString(metadata: Record<string, unknown> | undefined, field: string) {
  const value = metadata?.[field];
  return typeof value === "string" ? value : undefined;
}

// One mapping from a stored credential to provider options, shared by both
// auth loaders. They previously carried four hand-copied blocks that had
// already drifted: the legacy oauth branch dropped email/name and the metadata
// userID/machineID, and the two key branches disagreed on the type tag.
//
// opencode names the personal-access-token credential "api" on the legacy path
// and "key" on the v2 path, so both are treated identically here; the metadata
// fields are read uniformly because the legacy store may begin carrying them.
function credentialToOptions(credential: StoredCredential): QoderProviderOptions {
  const metadata = credential.metadata;
  if (credential.type === "oauth") {
    const decoded = decodeOAuthRefresh(credential.refresh || "");
    return {
      apiKey: credential.access,
      // Forwarded so a rejected job token can be renewed: opencode's plugin API
      // has no refresh hook, so refreshQoderCredentials() (auth.ts) is the only
      // caller, and it reads the token off the resolved credential. Without
      // this the stored refresh value never reaches it and a device-flow login
      // has no recovery from a "Login expired" other than a plain throw.
      // The composite (`refreshToken|uid|machineID`) is passed whole, not
      // decoded.refreshToken, so the uid and machine id survive the rotation.
      refreshToken: credential.refresh,
      qoderUserID: metadataString(metadata, "userID") || credential.accountId || decoded.userID,
      qoderEmail: metadataString(metadata, "email"),
      qoderName: metadataString(metadata, "name"),
      qoderMachineID: metadataString(metadata, "machineID") || decoded.machineID,
    };
  }
  if (credential.type === "key" || credential.type === "api") {
    return {
      apiKey: credential.key,
      qoderUserID: metadataString(metadata, "userID"),
      qoderEmail: metadataString(metadata, "email"),
      qoderName: metadataString(metadata, "name"),
      qoderMachineID: metadataString(metadata, "machineID"),
    };
  }
  return {};
}

async function authOptionsFromV2Connection(
  ctx: PluginContext,
  id: string,
): Promise<QoderProviderOptions> {
  const connection = await ctx.integration.connection.active(id);
  if (!connection) return {};
  // resolve() answers undefined when the credential is gone behind the
  // connection record.
  const credential = (await ctx.integration.connection.resolve(connection)) as
    | StoredCredential
    | undefined;
  return credential ? credentialToOptions(credential) : {};
}

async function setupV2(ctx: PluginContext): Promise<void> {
  const id = providerID(ctx.options);
  // Key names only. Records what this instance can see for itself -- ctx.options
  // is empty and ctx exposes no config or provider key, which is why the
  // credential has to arrive over the shared channel instead.
  logPlugin(
    `setup[v2]: pid=${process.pid} optionsKeys=${JSON.stringify(Object.keys(ctx.options ?? {}))} ` +
      `sharedApiKey=${tokenShape(readSharedApiKey())}`,
  );
  // Seed the pat-store from OPENCODE_QODER_PAT before anything authenticates.
  // Runs before discovery/transform so a freshly imported PAT can sign the very
  // first catalog refresh. The globalThis once-flag keeps a second plugin realm
  // (opencode loads this plugin twice per process) from re-importing and
  // re-logging; addPAT's own dedup makes even a repeat idempotent anyway.
  if (!readShared<boolean>(PAT_IMPORT_DONE_KEY)) {
    writeShared(PAT_IMPORT_DONE_KEY, true);
    maybeImportPATsFromEnv();
  }
  await ctx.integration.transform((integrations) => {
    integrations.update(id, (integration) => {
      integration.name = PROVIDER_NAME;
    });
    integrations.method.update({
      integrationID: id,
      method: { type: "key", label: "Qoder Personal Access Token" },
    });
    integrations.method.update({
      integrationID: id,
      method: { type: "env", names: [...QODER_PAT_ENV] },
    });
  });

  await ctx.catalog.transform((catalog) => {
    catalog.provider.update(id, (provider) => {
      provider.name = PROVIDER_NAME;
      provider.integrationID = id;
      // package MUST be this plugin's own module URL, NOT "@ai-sdk/openai-compatible".
      //
      // On 1.18.29 the v2 catalog is the serving path: opencode resolves the
      // SDK by package -- built-ins are a fixed map, anything else is imported
      // and its first `create*` export is called with the provider options.
      // With the openai-compatible package there, requests were served by the
      // GENERIC client (verified: a real chat request produced zero
      // wire-probe lines from QoderLanguageModel), silently discarding every
      // payload rule in language-model.ts -- including the context-tier
      // parameters.context_length injection. The legacy path already points
      // npm at this module (applyLegacyConfig), whose createQoder export is
      // exactly the factory opencode's fallback expects, so aligning the v2
      // package puts QoderLanguageModel back on the wire on both paths.
      provider.api = {
        type: "aisdk",
        package: import.meta.url,
        url: QODER_BASE_URL,
        settings: {},
      };
      provider.request = { headers: {}, body: {} };
      const apiKey = optionString(ctx.options, "apiKey");
      if (apiKey) provider.request.body.apiKey = apiKey;
    });

    for (const model of catalogModels()) {
      catalog.model.update(id, model.id, (draft) => {
        Object.assign(draft, v2ModelConfig(model));
      });
    }

    if (shouldSetDefault(ctx.options)) catalog.model.default.set(id, "auto");
  });
  logCatalogRegistration("v2");

  await ctx.aisdk.language(async (event) => {
    // Once per instance, not per request. Whether this handler is invoked at all
    // is worth knowing -- on current opencode it never is, and requests are
    // authenticated by opencode's own provider path instead -- but logging every
    // request would bury the lines that matter.
    if (!aisdkHandlerLogged) {
      aisdkHandlerLogged = true;
      logPlugin(
        `aisdk: pid=${process.pid} handler invoked providerID=${event.model.providerID} ` +
          `modelID=${String(event.model.api?.id ?? "?")} optionsApiKey=${tokenShape(event.options?.apiKey)}`,
      );
    }
    if (event.model.providerID !== id) return;
    // Was a bare await, so a rejection here killed the handler silently and
    // opencode authenticated by its own path -- leaving no trace of why
    // discovery never saw a credential.
    const connectionOptions = await authOptionsFromV2Connection(ctx, id).catch((error) => {
      logPlugin(`aisdk: connection lookup failed (${errorMessage(error)})`);
      return {} as QoderProviderOptions;
    });
    const apiKey =
      connectionOptions.apiKey || optionString(ctx.options, "apiKey") || event.options.apiKey;
    // Second capture point, and a fallback rather than the working path: on
    // current opencode this handler is never invoked at all (verified -- zero
    // aisdk log lines across a completed request), so the credential normally
    // arrives from the legacy config hook. Kept because an opencode version that
    // does route requests through here would otherwise leave discovery blind.
    if (typeof apiKey === "string" && apiKey.length > 0 && publishSharedApiKey(apiKey)) {
      logPlugin(`aisdk: published apiKey (${tokenShape(apiKey)}) for discovery`);
      onCredentialsCaptured?.();
    }
    event.language = new QoderLanguageModel(String(event.model.api.id), {
      ...event.options,
      ...connectionOptions,
      apiKey,
    });
  });

  if (discoveryDisabled()) return;

  // Dynamic model discovery. Refresh the live model list in the background and
  // reload opencode's catalog only when the table actually changed -- the same
  // pattern opencode's built-in console provider uses. The warmup timer runs at
  // the end of the event loop so setup() never blocks on the network.
  const discoveryOptions = async (): Promise<QoderProviderOptions> => {
    const connection = await authOptionsFromV2Connection(ctx, id).catch(
      () => ({}) as QoderProviderOptions,
    );
    const resolved = {
      ...ctx.options,
      ...connection,
      // Order matters: an explicit connection (from `/connect qoder`) beats the
      // plugin's own options, which beat the credential published by the legacy
      // config hook. resolveQoderCredentials() still falls back to the
      // QODER_PERSONAL_ACCESS_TOKEN env var after all of these -- the full
      // precedence table lives above resolveQoderCredentials() in auth.ts.
      apiKey: connection.apiKey || optionString(ctx.options, "apiKey") || readSharedApiKey(),
    };
    // Shapes and key names only -- the values here can be a PAT. This is what
    // distinguishes "discovery ran with no credentials" from "discovery ran and
    // the endpoint refused", which otherwise look identical from the outside:
    // both leave the catalog on the bundled fallback.
    logPlugin(
      `discovery: ctxOptions=${JSON.stringify(Object.keys(ctx.options ?? {}))} ` +
        `connection=${JSON.stringify(Object.keys(connection))} ` +
        `apiKey=${tokenShape(resolved.apiKey)}`,
    );
    return resolved;
  };
  const refreshCatalog = async (force: boolean): Promise<void> => {
    const before = catalogSignature();
    const status = await refreshModels(await discoveryOptions(), force);
    if (status.source !== "qoder" || catalogSignature() === before) return;
    if (typeof ctx.catalog.reload === "function") {
      // Fires exactly when a rendered name changed -- a new model, an edited
      // multiplier, or the Unavailable suffix appearing/disappearing, since
      // catalogSignature() signs quotaExhausted.
      logPlugin("catalog: changed -- reloading opencode's model list");
      await ctx.catalog.reload();
    }
  };
  // A swallowed rejection here is how discovery ends up silently stuck on the
  // bundled table, so both timers report instead of discarding.
  const logRefreshFailure = (error: unknown): void => {
    logPlugin(`refresh: failed (${errorMessage(error)})`);
  };
  // Armed only now: the aisdk handler above is registered before refreshCatalog
  // exists, so it fires this trigger rather than calling refreshCatalog directly.
  const forceRefresh = (): void => {
    refreshCatalog(true).catch(logRefreshFailure);
  };
  onCredentialsCaptured = forceRefresh;
  // Published for the legacy instance's tools (see triggerCatalogRefresh).
  writeShared(REFRESH_TRIGGER_KEY, forceRefresh);
  const warm = setTimeout(() => {
    refreshCatalog(true).catch(logRefreshFailure);
  }, 0);
  warm.unref?.();
  const timer = setInterval(() => {
    refreshCatalog(false).catch(logRefreshFailure);
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
}

// pollDeviceFlow() and its delay() helper live in auth.ts alongside every
// other credential-acquisition path; legacyHooks below only wires it into
// opencode's browser-login hook.

// Options for the capability layer. The legacy instance sees the plugin's own
// options (rarely populated) plus the token the config hook published over
// globalThis; env and opencode's auth.json are consulted inside capabilities.ts.
function capabilityOptions(options?: PluginOptions): QoderProviderOptions {
  const apiKey = optionString(options, "apiKey") || readSharedApiKey();
  return apiKey ? { apiKey } : {};
}

// Wraps a capability so a throw becomes a readable answer instead of a tool
// error with no cause. The structured half of the report rides along as the
// result metadata, so anything downstream of the tool call can compute on it
// without re-parsing the text.
function capabilityTool(
  name: string,
  run: () => Promise<CapabilityReport> | CapabilityReport,
  context: { metadata: (input: { title?: string }) => void },
) {
  context.metadata({ title: `Qoder: ${name}` });
  return Promise.resolve(run())
    .then((report) => ({ output: report.output, metadata: report.data as Record<string, unknown> }))
    .catch((error) => {
      const failed = capabilityError(name, error);
      return { output: failed.output, metadata: failed.data as Record<string, unknown> };
    });
}

// Read-only views of plugin state, registered as native tools so a model can
// ask about quota, models and credentials without shelling out. v2 exposes no
// tool registration surface (verified: PluginContext offers agent/aisdk/catalog/
// command/integration/reference/skill), so this legacy map is the only place
// they can live -- which also means they read the legacy instance's copy of the
// catalog. That copy seeds from the same on-disk cache the v2 instance writes at
// import time, so it is a snapshot rather than a dead fallback; anything that
// needs a live number (quota, availability) fetches it itself.
function capabilityTools(options?: PluginOptions): Hooks["tool"] {
  return {
    // Live credit balance. The one tool that answers "还剩多少额度".
    qoder_quota: tool({
      description:
        "Read the Qoder account's remaining credits: per-bucket balance (plan, add-on, " +
        "org package), total left, whether credits are exhausted, plan usage and renewal " +
        "date. Use when the user asks about 额度/配额/余额/credits or whether they can " +
        "still afford a paid model.",
      args: {},
      execute: (_args, ctx) =>
        capabilityTool("quota", () => reportQuota(capabilityOptions(options)), ctx),
    }),
    // Identity behind the credential.
    qoder_account: tool({
      description:
        "Read the Qoder account profile the current credential belongs to: name, email, " +
        "user and organisation IDs, registration source. Use when the user asks which " +
        "Qoder account is in use or whose quota is being spent.",
      args: {},
      execute: (_args, ctx) =>
        capabilityTool("account", () => reportAccount(capabilityOptions(options)), ctx),
    }),
    // The full picker table.
    qoder_models: tool({
      description:
        "List every Qoder model opencode is currently offering: id, credit multiplier, " +
        "context/input/output limits, thinking-effort levels, reasoning flag, and an " +
        "Unavailable marker on paid models when credits are drained. Use when the user " +
        "asks which models exist, which are cheapest, or which support reasoning.",
      args: {},
      execute: (_args, ctx) =>
        capabilityTool("models", () => reportModels(capabilityOptions(options)), ctx),
    }),
    // One model's limits, resolved exactly like a request resolves it.
    qoder_model: tool({
      description:
        "Show one Qoder model's details by id: limits, thinking efforts, credit " +
        "multiplier, and where its definition came from (live, cache or bundled). An " +
        "unknown id resolves to the fallback model and says so. Use when the user asks " +
        "about a specific model's limits or price.",
      args: { id: tool.schema.string().describe("Model id, e.g. cmodel or qmodel_38max") },
      execute: (args, ctx) => capabilityTool("model", () => reportModel(args.id), ctx),
    }),
    // Where the model list came from, and why.
    qoder_catalog: tool({
      description:
        "Show Qoder model-catalog diagnostics: whether the table came from the live API, " +
        "the disk cache or the bundled fallback; when it was fetched; the cache file " +
        "path; whether discovery is disabled by env. Use when a model is missing, stale, " +
        "or wrong -- this is the answer to 'why do I not see model X'.",
      args: {},
      execute: (_args, ctx) => capabilityTool("catalog", () => reportCatalog(), ctx),
    }),
    // Credential plumbing, shape-only.
    qoder_auth: tool({
      description:
        "Show which Qoder credential layer is in effect (option, config hook, auth.json, " +
        "env) and what it resolves to -- identity and expiry only, never the token " +
        "itself. Use when requests fail with auth errors or the user asks how login is " +
        "configured.",
      args: {},
      execute: (_args, ctx) =>
        capabilityTool("auth", () => reportAuth(capabilityOptions(options)), ctx),
    }),
    // Multi-PAT management: list stored accounts.
    qoder_pat_list: tool({
      description:
        "List all stored Qoder PATs (Personal Access Tokens). Shows id, label, email, " +
        "and which one is currently active. Use when the user asks 'which accounts do I have' " +
        "or 'which PAT is active'.",
      args: {},
      execute: () => {
        const pats = listPATs();
        const active = getActivePAT();
        const output =
          pats.length === 0
            ? "No PATs stored yet. Use qoder_pat_add to add one."
            : pats
                .map((p) => {
                  const marker = p.active ? " [ACTIVE]" : "";
                  const email = p.email ? ` (${p.email})` : "";
                  return `${p.id}: ${p.label}${email}${marker}`;
                })
                .join("\n");
        return Promise.resolve({ output, data: { pats, activeId: active?.id } });
      },
    }),
    // Multi-PAT management: switch active account.
    qoder_pat_switch: tool({
      description:
        "Switch the active Qoder PAT to a different stored account. The id must match " +
        "one shown by qoder_pat_list. Use when the user says 'switch to account X' or " +
        "'use my other PAT'.",
      args: { id: tool.schema.string().describe("PAT id from qoder_pat_list") },
      execute: (args) => {
        const success = switchPAT(args.id);
        const output = success
          ? `Switched to ${args.id}. This PAT will be used for all subsequent requests.`
          : `PAT ${args.id} not found. Run qoder_pat_list to see available accounts.`;
        return Promise.resolve({ output, data: { success, id: args.id } });
      },
    }),
    // Multi-PAT management: add a new PAT.
    qoder_pat_add: tool({
      description:
        "Add a new Qoder PAT (Personal Access Token) to the store. The label is a " +
        "human-readable name like 'Work Account' or 'Personal'. If this is the first " +
        "PAT, it becomes active automatically. Use when the user says 'add my other account' " +
        "or provides a new PAT.",
      args: {
        pat: tool.schema.string().describe("The Personal Access Token (pt-...)"),
        label: tool.schema.string().describe("Human-readable label, e.g. 'Work Account'"),
        email: tool.schema.string().optional().describe("Account email (optional, for display)"),
      },
      execute: (args) => {
        const entry = addPAT(args.pat, args.label, args.email);
        const output = entry
          ? `Added ${entry.id} (${entry.label}). ${entry.active ? "This is now the active PAT." : "Use qoder_pat_switch to activate it."}`
          : `PAT already exists (duplicate detected).`;
        return Promise.resolve({ output, data: { entry } });
      },
    }),
    // Multi-PAT management: remove a PAT.
    qoder_pat_remove: tool({
      description:
        "Remove a stored Qoder PAT. The id must match one shown by qoder_pat_list. " +
        "If the removed PAT was active, no other PAT becomes active automatically. " +
        "Use when the user says 'remove account X' or 'delete my old PAT'.",
      args: { id: tool.schema.string().describe("PAT id from qoder_pat_list") },
      execute: (args) => {
        const success = removePAT(args.id);
        const output = success ? `Removed ${args.id}.` : `PAT ${args.id} not found.`;
        return Promise.resolve({ output, data: { success, id: args.id } });
      },
    }),
    // Context tiers: what each model offers and what is currently selected.
    qoder_tier_list: tool({
      description:
        "Show each Qoder model's selectable context tiers (from the live context_config) " +
        "and any currently selected tier. The DEFAULT tier is what requests run at when " +
        "nothing is selected. Use when the user asks about 上下文档位/1M/long context or " +
        "before switching a model's context window.",
      args: {},
      execute: (_args, ctx) => {
        const selections = listSelectedTiers();
        const root = ctx.sessionID ? resolveRootSession(ctx.sessionID) : "";
        const sessionTier = root ? getSessionTier(root) : undefined;
        const tiers = catalogModels()
          .filter((model) => (model.contextTiers?.length ?? 0) > 0 || model.id in selections)
          .map((model) => ({
            model: model.id,
            defaultTier: model.contextWindow,
            availableTiers: model.contextTiers ?? [model.contextWindow],
            selected: selections[model.id] ?? null,
          }));
        const header =
          sessionTier !== undefined
            ? `This conversation runs at the ${sessionTier}-token tier (session ${root}).\n\n`
            : "This conversation runs at each model's default tier (no switch yet).\n\n";
        const output =
          header +
          (tiers.length === 0
            ? "No model advertises multiple context tiers. All run at their default tier."
            : tiers
                .map((entry) => {
                  const selected = entry.selected
                    ? ` [displayed: ${entry.selected}]`
                    : " [default]";
                  return `${entry.model}: ${entry.availableTiers.join(" / ")}${selected}`;
                })
                .join("\n") +
              "\n\nSwitch for THIS conversation with qoder_tier_switch(model, tier); subagent " +
              "requests (compaction, task children) follow the same tier automatically.");
        return Promise.resolve({ output, data: { tiers, sessionTier: sessionTier ?? null } });
      },
    }),
    // Context tiers: select a tier for THIS conversation (or clear it).
    qoder_tier_switch: tool({
      description:
        "Select a context tier for THIS conversation's Qoder model, e.g. 1000000 for the " +
        "1M window. The tier must be one of the model's advertised tiers (see " +
        "qoder_tier_list); omit it to return the conversation to its default. The binding " +
        "is per-conversation: this chat and its subagents (compaction, task children) all " +
        "run at the chosen tier, while a brand-new chat still defaults. Use when the user " +
        "says 'switch to 1M context' or 'reset the context tier'.",
      args: {
        model: tool.schema.string().describe("Model id, e.g. cmodel or ultimate"),
        tier: tool.schema
          .number()
          .optional()
          .describe("Tier in tokens (e.g. 1000000). Omit to restore the default tier."),
      },
      execute: (args, ctx) => {
        const def = catalogModels().find((model) => model.id === args.model);
        if (!def) {
          return Promise.resolve({
            output: `Model "${args.model}" not found. Run qoder_models to list available models.`,
            data: { success: false },
          });
        }
        const root = ctx.sessionID ? resolveRootSession(ctx.sessionID) : "";
        if (args.tier === undefined) {
          const clearedSession = root ? clearSessionTier(root) : false;
          const clearedMode = clearTier(args.model);
          triggerCatalogRefresh();
          return Promise.resolve({
            output:
              clearedSession || clearedMode
                ? `This conversation returns to ${args.model}'s default tier (${def.contextWindow} tokens).`
                : `This conversation had no tier switch for ${args.model}; it already runs at the default.`,
            data: { success: true, cleared: clearedSession || clearedMode },
          });
        }
        if (!isValidContextTier(def, args.tier)) {
          const offered =
            def.contextTiers?.join(" / ") ?? `<= ${def.inputWindow ?? def.contextWindow}`;
          return Promise.resolve({
            output:
              `Tier ${args.tier} is not valid for ${args.model}. ` +
              `Accepted values: ${offered}. Run qoder_tier_list for the full table.`,
            data: { success: false },
          });
        }
        // The session binding drives the wire; the mode drives the picker label
        // and the registered (compaction-threshold) limits. A missing root id
        // (no session yet) degrades to the global mode alone.
        if (root) setSessionTier(root, args.tier);
        setTier(args.model, args.tier);
        const refreshed = triggerCatalogRefresh();
        // Subagent handling: above the pinned helper model's window the routing
        // policy escalates compaction/task requests to a model that advertises
        // this tier, so the whole exchange -- not just the main thread -- fits.
        const policy = getRoutingPolicy();
        const routingNote =
          args.tier > policy.threshold
            ? policy.enabled
              ? `\n\nPinned subagents (compaction, task children) auto-escalate to ${policy.target} at this tier (policy: qoder_routing_policy).`
              : `\n\nWarning: routing is disabled, so the compaction agent stays on a ${policy.threshold}-token model and cannot compact this conversation above that. Re-enable with qoder_routing_policy, or override agent.compaction in opencode.json.`
            : "";
        return Promise.resolve({
          output:
            `This conversation now runs at the ${args.tier}-token tier on ${args.model} (was ${def.contextWindow}). ` +
            (refreshed
              ? "The picker label and compaction limits update on the next model re-select; restart opencode if they lag."
              : "Restart opencode to update the picker label and limits.") +
            routingNote,
          data: { success: true, model: args.model, tier: args.tier, session: root || null },
        });
      },
    }),
    // Subagent routing: which model serves pinned helpers above the default tier.
    qoder_routing_policy: tool({
      description:
        "Show or set the subagent routing policy -- how pinned helper agents (compaction, " +
        "task children, plan) are served when a conversation runs above the default " +
        "context tier. With no arguments it reports the current policy. Set target to " +
        "change the escalated model, threshold to change the token count that triggers it, " +
        "subagentModel to change the pinned base model, exemptAgents to list agents that " +
        "keep the base model, or enabled=false to disable escalation entirely. Use when the " +
        "user asks which model handles long-context subagents or how compaction fits a 1M tier.",
      args: {
        enabled: tool.schema
          .boolean()
          .optional()
          .describe("Master switch; false pins every request to its selected model."),
        subagentModel: tool.schema
          .string()
          .optional()
          .describe("The pinned helper model this policy escalates (default lite)."),
        target: tool.schema
          .string()
          .optional()
          .describe("Where escalated requests go (default qfmodel)."),
        threshold: tool.schema
          .number()
          .optional()
          .describe("Escalate when the conversation tier exceeds this many tokens."),
        exemptAgents: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Agents that keep the base model even above the threshold."),
      },
      execute: (args) => {
        const patch: Partial<RoutingPolicy> = {};
        if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
        if (args.subagentModel) patch.subagentModel = args.subagentModel;
        if (args.target) patch.target = args.target;
        if (args.threshold !== undefined) patch.threshold = args.threshold;
        if (args.exemptAgents) patch.exemptAgents = args.exemptAgents;
        const changed = Object.keys(patch).length > 0;
        const policy = changed ? updateRoutingPolicy(patch) : getRoutingPolicy();
        if (changed && args.target && !catalogModels().some((m) => m.id === args.target)) {
          return Promise.resolve({
            output: `Target "${args.target}" is not a known model. Policy left as: ${describePolicy(policy)}.`,
            data: { success: false, policy },
          });
        }
        return Promise.resolve({
          output: `${changed ? "Updated " : ""}routing policy: ${describePolicy(policy)}.`,
          data: { success: true, policy },
        });
      },
    }),
  };
}

// One-line rendering of the routing policy for the tool surface.
function describePolicy(policy: RoutingPolicy): string {
  if (!policy.enabled) return "disabled (subagents stay on their selected model)";
  return (
    `${policy.subagentModel} -> ${policy.target} above ${policy.threshold} tokens` +
    ` (exempt: ${policy.exemptAgents.join(", ") || "none"})`
  );
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as LegacyConfig, options),
    // Identity stamp for the request layer.
    //
    // opencode hands the agent name to this hook but never forwards it to the
    // language model; resolveRequestRoute() in language-model.ts needs it to
    // apply the routing policy's exempt-agent list (title/summary stay on the
    // cheap base model, compaction escalates). X-Qoder-Session is stamped from
    // the same input rather than leaning on opencode's native X-Session-Id
    // header name, which the request path still reads as a fallback.
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== id) return;
      if (input.agent !== "") output.headers["x-qoder-agent"] = input.agent;
      output.headers["x-qoder-session"] = input.sessionID;
    },
    // Session tree: subagent spawns (task tool, compaction) arrive here with
    // a parentID, which is how session-roots learns child -> root. The only
    // mutation for a ROOT creation is the display-mode reset, so a fresh
    // conversation shows (and defaults to) the model's stock tier -- the
    // conversation-scoped session entries are deliberately NOT cleared; some
    // other window's 1M chat must keep its wire tier.
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info;
        if (info.id === undefined || info.id === "") return;
        recordSessionParent(info.id, info.parentID);
        if (info.parentID === undefined && clearAllTiers()) {
          triggerCatalogRefresh();
        }
        return;
      }
      if (event.type === "session.deleted") {
        forgetSession(event.properties.info.id);
      }
    },
    tool: capabilityTools(options),
    auth: {
      provider: id,
      loader: async (auth) => {
        const stored = (await auth()) as StoredCredential | undefined;
        return stored ? credentialToOptions(stored) : {};
      },
      methods: [
        {
          type: "api",
          label: "Personal Access Token",
        },
        {
          type: "oauth",
          label: "Browser Login",
          authorize: async () => {
            const { codeVerifier, codeChallenge } = generatePKCE();
            const nonce = crypto.randomUUID();
            const machineID = getMachineId();
            const url = `${QODER_MANAGE_URL}/device/selectAccounts?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
            return {
              url,
              instructions: "Complete the Qoder browser login, then return to opencode.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const credential = await pollDeviceFlow(codeVerifier, nonce, machineID);
                  return {
                    type: "success" as const,
                    provider: id,
                    refresh: credential.refresh,
                    access: credential.access,
                    expires: credential.expires,
                    accountId: credential.userID,
                  };
                } catch (error) {
                  // opencode only surfaces the failed verdict, not the cause --
                  // without this line a timeout, a network error, and a poll
                  // rejection are indistinguishable to the user.
                  logPlugin(`auth: device flow failed: ${errorMessage(error)}`);
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
      ],
    },
  };
}

const plugin = {
  id: "opencode-qoder",
  setup: setupV2,
  server: async (_input: PluginInput, options?: PluginOptions) => legacyHooks(options),
};

export default plugin;
