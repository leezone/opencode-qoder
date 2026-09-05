import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  decodeOAuthRefresh,
  encodeOAuthRefresh,
  generatePKCE,
  type QoderCredentials,
  type QoderProviderOptions,
} from "./auth.js";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  QODER_BASE_URL,
  QODER_OPENAPI_URL,
  QODER_PAT_ENV,
  USER_AGENT,
  ZERO_COST,
} from "./constants.js";
import { getMachineId } from "./cosy.js";
import { createQoder, QoderLanguageModel } from "./language-model.js";
import { logPlugin } from "./log.js";
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

// Describes a credential without ever printing it. A log file is no place for a
// PAT, but the shape is exactly what tells an unresolved `{file:...}` reference
// apart from a real token, or from the option not reaching the plugin at all.
function tokenShape(value: unknown): string {
  if (typeof value !== "string" || value === "") return "absent";
  if (value.startsWith("{file:")) return "file-ref";
  if (value.startsWith("{env:")) return "env-ref";
  if (value.startsWith("pt-")) return "pat";
  return `opaque(${value.length})`;
}

function optionString(
  options: PluginOptions | undefined,
  key: keyof QoderPluginOptions,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  const value = sharedState()[CREDENTIAL_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function legacyModelConfig(model: DiscoveredModel) {
  const config: Record<string, unknown> = {
    // Carries the credit multiplier and the exhausted marker -- see
    // displayName(), which explains why it cannot be a description field.
    name: displayName(model),
    reasoning: model.reasoning,
    tool_call: true,
    attachment: model.input.includes("image"),
    cost: ZERO_COST,
    limit: {
      context: model.contextWindow,
      // opencode's auto-compaction threshold derives from limit.input, so it
      // must reflect the tier the gateway actually applies, not the largest one.
      input: model.inputWindow ?? model.contextWindow,
      output: model.maxTokens,
    },
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
    limit: {
      context: model.contextWindow,
      input: model.inputWindow ?? model.contextWindow,
      output: model.maxTokens,
    },
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

async function authOptionsFromV2Connection(
  ctx: PluginContext,
  id: string,
): Promise<QoderProviderOptions> {
  const connection = await ctx.integration.connection.active(id);
  const credential = connection
    ? ((await ctx.integration.connection.resolve(connection)) as StoredCredential)
    : undefined;
  if (!credential) return {};

  if (credential.type === "key") {
    return {
      apiKey: credential.key,
      qoderUserID: metadataString(credential.metadata, "userID"),
      qoderEmail: metadataString(credential.metadata, "email"),
      qoderName: metadataString(credential.metadata, "name"),
      qoderMachineID: metadataString(credential.metadata, "machineID"),
    };
  }

  if (credential.type === "oauth") {
    const decoded = decodeOAuthRefresh(credential.refresh || "");
    return {
      apiKey: credential.access,
      qoderUserID:
        metadataString(credential.metadata, "userID") || credential.accountId || decoded.userID,
      qoderEmail: metadataString(credential.metadata, "email"),
      qoderName: metadataString(credential.metadata, "name"),
      qoderMachineID: metadataString(credential.metadata, "machineID") || decoded.machineID,
    };
  }

  return {};
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
      logPlugin(
        `aisdk: connection lookup failed (${error instanceof Error ? error.message : String(error)})`,
      );
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
      // QODER_PERSONAL_ACCESS_TOKEN env var after all of these.
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
    logPlugin(`refresh: failed (${error instanceof Error ? error.message : String(error)})`);
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

function abortableDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollDeviceFlow(
  codeVerifier: string,
  nonce: string,
  machineID: string,
): Promise<QoderCredentials> {
  const pollURL = `${QODER_OPENAPI_URL}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

  for (let attempt = 0; attempt < 90; attempt++) {
    await abortableDelay(2000);
    const response = await fetch(pollURL, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (response.status === 202 || response.status === 404) continue;
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Device token poll failed: ${response.status} ${response.statusText}. Response: ${errText}`,
      );
    }

    const tokenData = (await response.json()) as {
      token?: string;
      user_id?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    };
    if (!tokenData.token) throw new Error("Device token poll returned empty access token");

    let email = "";
    let name = "";
    try {
      const userinfoRes = await fetch(`${QODER_OPENAPI_URL}/api/v1/userinfo`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
      if (userinfoRes.ok) {
        const userinfo = (await userinfoRes.json()) as {
          email?: string;
          name?: string;
          username?: string;
        };
        email = userinfo.email || "";
        name = userinfo.name || userinfo.username || "";
      }
    } catch {}

    const parsedExpires = tokenData.expires_at ? Date.parse(tokenData.expires_at) : Number.NaN;
    const expires = Number.isFinite(parsedExpires)
      ? parsedExpires
      : Date.now() + (tokenData.expires_in || 30 * 24 * 60 * 60) * 1000;

    return {
      refresh: encodeOAuthRefresh(
        tokenData.refresh_token || "",
        tokenData.user_id || "",
        machineID,
      ),
      access: tokenData.token,
      expires: expires - 5 * 60 * 1000,
      userID: tokenData.user_id || "qoder-user",
      email: email || "user@qoder.com",
      name: name || "Qoder User",
      machineID,
    };
  }

  throw new Error("Authorization timed out");
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as LegacyConfig, options),
    auth: {
      provider: id,
      loader: async (auth) => {
        const stored = (await auth()) as StoredCredential | undefined;
        if (!stored) return {};
        if (stored.type === "api") {
          return {
            apiKey: stored.key,
            qoderUserID: metadataString(stored.metadata, "userID"),
            qoderEmail: metadataString(stored.metadata, "email"),
            qoderName: metadataString(stored.metadata, "name"),
            qoderMachineID: metadataString(stored.metadata, "machineID"),
          };
        }
        if (stored.type === "oauth") {
          const decoded = decodeOAuthRefresh(stored.refresh || "");
          return {
            apiKey: stored.access,
            qoderUserID: stored.accountId || decoded.userID,
            qoderMachineID: decoded.machineID,
          };
        }
        return {};
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
            const url = `https://qoder.com/device/selectAccounts?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
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
                } catch {
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
