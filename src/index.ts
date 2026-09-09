import { type Hooks, type PluginInput, type PluginOptions, tool } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  decodeOAuthRefresh,
  generatePKCE,
  pollDeviceFlow,
  type QoderProviderOptions,
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
  refreshModels,
} from "./model-catalog.js";

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

// The "usable string" guard shared by option and globalThis reads: absent,
// non-string and empty-string all collapse to undefined. (metadataString next
// to credentialToOptions deliberately keeps a weaker guard -- it returns "" as
// a real value -- so it is NOT folded in here.)
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionString(
  options: PluginOptions | undefined,
  key: keyof QoderPluginOptions,
): string | undefined {
  return nonEmptyString(options?.[key]);
}

// Credential channel between the two module instances of this plugin.
//
// opencode loads this file twice in one process: once for the legacy config
// hooks, once for the v2 catalog hooks. Established by logging a per-instance
// id alongside the pid -- same pid, different instance ids, and neither can
// read the other's module state. A module-level `configuredApiKey` therefore
// cannot work: the instance that sees the credential is not the instance that
// runs discovery.
//
// They do share a realm, so globalThis is the one channel available. It carries
// the token from the legacy config hook (which sees the user's provider options
// already resolved from `{file:...}`) to discoveryOptions (whose ctx.options is
// empty and whose ctx exposes no config or provider key).
//
// The value stays in process memory: never written to disk, never logged --
// logPlugin only ever receives tokenShape() of it. The same token already lives
// in this realm inside opencode's own config object, so this does not widen
// exposure; the fixed key is a collision risk, not a leak.
const CREDENTIAL_KEY = "__opencode_qoder_api_key";

function sharedState(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function readSharedApiKey(): string | undefined {
  return nonEmptyString(sharedState()[CREDENTIAL_KEY]);
}

// First writer wins: a later hook invocation must not replace a working token
// with an empty one, and an unresolved `{file:...}` reference must not overwrite
// a real token either.
function writeSharedApiKey(apiKey: string): boolean {
  if (readSharedApiKey() !== undefined) return false;
  sharedState()[CREDENTIAL_KEY] = apiKey;
  return true;
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
interface LegacyConfig {
  provider?: Record<string, LegacyProviderConfig>;
  model?: string;
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
    if (configured && writeSharedApiKey(configured)) {
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
      package: "@ai-sdk/openai-compatible",
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

// Minimal shape of an opencode-stored credential. The plugin API returns it
// untyped, so we declare the fields this plugin actually consumes.
interface StoredCredential {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
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
      provider.api = {
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
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
    if (typeof apiKey === "string" && apiKey.length > 0 && writeSharedApiKey(apiKey)) {
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
  onCredentialsCaptured = () => {
    refreshCatalog(true).catch(logRefreshFailure);
  };
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
  };
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as LegacyConfig, options),
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
