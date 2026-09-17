import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// The daily-campaign surface (qodercli's /claim equivalent). Marketing scope:
// nothing here is on the model/chat/quota path, and claimDisabled() removes both
// tools and the campaign skill in one switch. See claim.ts for the contract.
import { claimDisabled, reportCampaigns, runClaim } from "./claim.js";
import { nonEmptyString } from "./coerce.js";
import {
  PROVIDER_ID,
  PROVIDER_ID_CN,
  PROVIDER_NAME,
  PROVIDER_NAME_CN,
  providerIDForRegion,
  providerNameForRegion,
  QODER_PAT_ENV,
  type QoderRegion,
  regionOfProviderID,
  resolveEndpoints,
  sharedKey,
  ZERO_COST,
} from "./constants.js";
import { getMachineId } from "./cosy.js";
import { readEnv } from "./env.js";
import { refreshKeyFile, setKeyFilePath } from "./key-file.js";
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
import { reportPatAdd, reportPatList, reportPatRemove, reportPatSwitch } from "./pat-tools.js";
import { forgetSession, recordSessionParent } from "./session-roots.js";
import { publishSharedApiKey, readShared, readSharedApiKey, writeShared } from "./shared-state.js";
import { clearAllTiers, getSelectedTier } from "./tier-store.js";
import { reportRoutingPolicy, reportTierList, reportTierSwitch } from "./tier-tools.js";

export { createQoder, QoderLanguageModel };

type QoderPluginOptions = PluginOptions & {
  providerID?: string;
  // "global" (default) or "cn"; an alternative to naming the provider qoder-cn.
  region?: QoderRegion;
  setDefault?: boolean;
  apiKey?: string;
  // Path to the seed key file (see key-file.ts). Relative paths resolve from
  // the home directory; "none" disables the layer. Default ~/.qoderkey_env.
  keyFile?: string;
};

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// How often the live key-file check runs. One statSync per tick until the
// mtime moves; the import only re-parses on a real change.
const KEY_FILE_CHECK_INTERVAL_MS = 60 * 1000;

// Emitted from both registration paths, so the log shows where the names came
// from whichever opencode version is driving. `source` is the field that
// distinguishes a bundled fallback -- where no name carries a multiplier,
// because the static table has no priceFactor -- from live or cached data.
function logCatalogRegistration(path: "legacy" | "v2", region: QoderRegion): void {
  const status = catalogStatus(region);
  // pid tells whether the legacy and v2 hooks share a process -- if they do not,
  // anything captured in one is invisible to the other.
  logPlugin(
    `catalog[${path}]: pid=${process.pid} registered ${status.total} models ` +
      `(source=${status.source}, live=${status.live}, region=${region})`,
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
//
// Every one of these keys is region-scoped: both providers share globalThis,
// so an unscoped trigger would have a CN tier switch force-refresh the
// international catalog (and reload the wrong model list).
function refreshTriggerKey(region: QoderRegion): string {
  return sharedKey("refresh_trigger", region);
}
// Marks that the DISPLAY mode just changed (a tier switch/clear), before the
// next refreshCatalog(). The picker labels are rendered from getSelectedTier,
// while refreshCatalog's change detection compares signatures taken AFTER the
// mutation already landed -- a tier switch alone therefore always "looks
// unchanged" and the reload gets suppressed, which is exactly why switching
// showed nothing until some unrelated refresh or restart happened.
function labelDirtyKey(region: QoderRegion): string {
  return sharedKey("label_dirty", region);
}

// Once-flag for the OPENCODE_QODER_PAT bootstrap import. opencode loads this
// plugin twice per process and neither realm sees the other's module state, so
// the flag lives on globalThis; addPAT's dedup makes a repeat idempotent, the
// flag only prevents a re-log.
function patImportDoneKey(region: QoderRegion): string {
  return sharedKey("pat_import_done", region);
}

function triggerCatalogRefresh(region: QoderRegion, labelChanged = false): boolean {
  if (labelChanged) writeShared(labelDirtyKey(region), true);
  const trigger = readShared(refreshTriggerKey(region));
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

// Which Qoder deployment this plugin instance serves. Two sources, in order:
// an explicit `region` option, then the provider id (a CN config names the
// provider "qoder-cn"). Either way it is resolved per call, never cached in
// module state -- both instances share this process.
function regionOfPluginOptions(options?: PluginOptions): QoderRegion {
  const explicit = optionString(options, "region");
  if (explicit === "cn" || explicit === "global") return explicit;
  return regionOfProviderID(optionString(options, "providerID"));
}

function providerID(options?: PluginOptions): string {
  const explicit = optionString(options, "providerID");
  if (explicit) return explicit;
  return regionOfPluginOptions(options) === "cn" ? PROVIDER_ID_CN : PROVIDER_ID;
}

function providerName(options?: PluginOptions): string {
  return regionOfPluginOptions(options) === "cn" ? PROVIDER_NAME_CN : PROVIDER_NAME;
}

function shouldSetDefault(options?: PluginOptions): boolean {
  return options?.setDefault === true;
}

// The `limit` triple is identical on both config surfaces; only the v1 legacy
// path carried the explanation, so the comment now lives with the shape.
function modelLimit(
  model: DiscoveredModel,
  region: QoderRegion,
): { context: number; input: number; output: number } {
  // A selected context tier overrides the default-tier limits, so opencode's
  // auto-compaction threshold defers past the default tier instead of
  // compacting at ~180k while the gateway would still accept input at the
  // selected tier. The selection was validated against the model's advertised
  // tiers at switch time; re-checked here because the live table may have
  // changed since (a tier the gateway stopped advertising must not keep
  // driving the registered limits).
  const tier = getSelectedTier(model.id, region);
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

function legacyModelConfig(model: DiscoveredModel, region: QoderRegion) {
  const config: Record<string, unknown> = {
    // Carries the credit multiplier and the exhausted marker -- see
    // displayName(), which explains why it cannot be a description field.
    name: displayName(model, region),
    reasoning: model.reasoning,
    tool_call: true,
    attachment: model.input.includes("image"),
    cost: ZERO_COST,
    limit: modelLimit(model, region),
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
  const region = regionOfPluginOptions(options);
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
  current.options.baseURL ??= resolveEndpoints(regionOfPluginOptions(options)).baseUrl;
  // The seed key file lives here because this hook is the only place that sees
  // the user's provider options. Record the configured path, then run the
  // first check immediately so a list-form file has seeded the store before
  // discovery authenticates its first request.
  {
    const keyFile = optionString(options, "keyFile") ?? optionString(current.options, "keyFile");
    if (keyFile) setKeyFilePath(keyFile);
    const state = refreshKeyFile(region);
    if (state.kind === "list") {
      logPlugin(`legacy: key file ${state.path} is a PAT list; the pat-store drives auth`);
    }
  }
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

  for (const model of catalogModels(region)) {
    current.models[model.id] = {
      ...legacyModelConfig(model, region),
      ...(current.models[model.id] ?? {}),
    };
  }

  if (shouldSetDefault(options) && !cfg.model) cfg.model = `${id}/auto`;
  logCatalogRegistration("legacy", region);

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

function v2ModelConfig(model: DiscoveredModel, region: QoderRegion) {
  return {
    // ConfigV2.Model has no description field either, so the annotation rides
    // on name exactly as in the legacy path.
    name: displayName(model, region),
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
      url: resolveEndpoints(region).baseUrl,
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
    limit: modelLimit(model, region),
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

// Installs the skills/ folder shipped inside the package by registering it as a
// v2 skill source. Verified on opencode 1.18.30: ctx.skill.transform() only
// stores the hook -- the draft callback runs when the host next builds the
// skill list, so we call ctx.skill.reload() right after registering to force
// that rebuild (without it the bundled source stays invisible until some
// other event rebuilds the draft). The skill then shows up in GET /api/skill
// with no manual copy step. The path resolves relative to this module, so the
// skill always matches the plugin actually loaded (repo checkout in dev, cache
// package when installed). Escape hatch: QODER_DISABLE_BUNDLED_SKILL=1.
// Non-fatal by design: a host without ctx.skill, a missing folder, or a
// rejected transform must not take the provider down -- worst case the skill
// is absent, exactly like before this existed.
function registerBundledSkills(ctx: PluginContext): void {
  if (readEnv("QODER_DISABLE_BUNDLED_SKILL")) {
    logPlugin("skill: bundled-source registration disabled by env");
    return;
  }
  // The campaign skill is the /qoder-claim command surface for the daily
  // check-in. It lives in its own folder, outside skills/, so withdrawing the
  // marketing activity means deleting one directory and one line here -- the
  // permanent skills stay untouched. Same switch as the tools.
  const dirs = [
    new URL("../skills/", import.meta.url),
    ...(claimDisabled() ? [] : [new URL("../skills-campaign/", import.meta.url)]),
  ];
  for (const url of dirs) {
    const dir = fileURLToPath(url);
    if (!existsSync(dir)) {
      logPlugin(`skill: bundled dir missing (${dir}), no source registered`);
      continue;
    }
    const skill = ctx.skill;
    if (!skill || typeof skill.transform !== "function") {
      logPlugin(
        `skill: host has no ctx.skill surface (skill=${typeof skill}), bundled source skipped`,
      );
      return;
    }
    void skill
      .transform((skills) => {
        skills.source({ type: "directory", path: dir });
        logPlugin(`skill: source added (${dir})`);
      })
      .then(() => skill.reload())
      .catch((error) => logPlugin(`skill: registration failed (${errorMessage(error)})`));
  }
}

// The region this realm serves. setupV2 is a closure over it because
// ctx.options is opencode's own bag and cannot be extended by the plugin --
// the region is known from the plugin entry that constructed this setup.
async function setupV2(ctx: PluginContext, region: QoderRegion): Promise<void> {
  const id = providerIDForRegion(region);
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
  if (!readShared<boolean>(patImportDoneKey(region))) {
    writeShared(patImportDoneKey(region), true);
    // The seed key file first: it is the plugin-owned credential source, and a
    // list-form file must have seeded the store before the env import's log
    // lines (or any discovery request) compare against it.
    refreshKeyFile(region);
    maybeImportPATsFromEnv(region);
  }
  await ctx.integration.transform((integrations) => {
    integrations.update(id, (integration) => {
      integration.name = providerName(ctx.options);
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
      provider.name = providerName(ctx.options);
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
        url: resolveEndpoints(region).baseUrl,
        settings: {},
      };
      provider.request = { headers: {}, body: {} };
      const apiKey = optionString(ctx.options, "apiKey");
      if (apiKey) provider.request.body.apiKey = apiKey;
    });

    for (const model of catalogModels(region)) {
      catalog.model.update(id, model.id, (draft) => {
        Object.assign(draft, v2ModelConfig(model, region));
      });
    }

    if (shouldSetDefault(ctx.options)) catalog.model.default.set(id, "auto");
  });
  logCatalogRegistration("v2", region);

  // Install the bundled skill alongside the plugin itself: registering the
  // package's skills/ dir as a v2 source means "plugin installed == skill
  // installed", with no manual copy step that can half-fail.
  registerBundledSkills(ctx);

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
    const before = catalogSignature(region);
    const status = await refreshModels(await discoveryOptions(), force);
    if (status.source !== "qoder") return;
    // Consume the flag only once the reload actually fires; an offline tick
    // leaves it set so the next successful refresh still delivers it.
    const labelDirty = readShared(labelDirtyKey(region)) === true;
    if (!labelDirty && catalogSignature(region) === before) return;
    writeShared(labelDirtyKey(region), undefined);
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
  writeShared(refreshTriggerKey(region), forceRefresh);
  const warm = setTimeout(() => {
    refreshCatalog(true).catch(logRefreshFailure);
  }, 0);
  warm.unref?.();
  const timer = setInterval(() => {
    refreshCatalog(false).catch(logRefreshFailure);
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
  // The live key-file check. Much faster cadence than the catalog refresh
  // because it is a single statSync until the mtime moves, and it is what makes
  // "edit the file, it re-seeds without a restart" true rather than a startup
  // once. A list-to-new-member edit lands on the store within one tick; the
  // next request authenticates with it (pat-store reloads by its own mtime).
  const keyFileTimer = setInterval(() => {
    refreshKeyFile(region);
  }, KEY_FILE_CHECK_INTERVAL_MS);
  keyFileTimer.unref?.();
}

// pollDeviceFlow() and its delay() helper live in auth.ts alongside every
// other credential-acquisition path; legacyHooks below only wires it into
// opencode's browser-login hook.

// Options for the capability layer. The legacy instance sees the plugin's own
// options (rarely populated) plus the token the config hook published over
// globalThis; env and opencode's auth.json are consulted inside capabilities.ts.
function capabilityOptions(options?: PluginOptions): QoderProviderOptions {
  const apiKey = optionString(options, "apiKey") || readSharedApiKey();
  const region = regionOfPluginOptions(options);
  return apiKey ? { apiKey, region } : { region };
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
  const region = regionOfPluginOptions(options);
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
      execute: (args, ctx) => capabilityTool("model", () => reportModel(args.id, region), ctx),
    }),
    // Where the model list came from, and why.
    qoder_catalog: tool({
      description:
        "Show Qoder model-catalog diagnostics: whether the table came from the live API, " +
        "the disk cache or the bundled fallback; when it was fetched; the cache file " +
        "path; whether discovery is disabled by env. Use when a model is missing, stale, " +
        "or wrong -- this is the answer to 'why do I not see model X'.",
      args: {},
      execute: (_args, ctx) => capabilityTool("catalog", () => reportCatalog(region), ctx),
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
      execute: () => Promise.resolve(reportPatList(region)),
    }),
    // Multi-PAT management: switch active account.
    qoder_pat_switch: tool({
      description:
        "Switch the active Qoder PAT to a different stored account. The id must match " +
        "one shown by qoder_pat_list. Use when the user says 'switch to account X' or " +
        "'use my other PAT'. An explicit switch OUTRANKS a configured credential (the " +
        "key file or apiKey option) until it is cleared; omit the id to clear it and " +
        "let the configured single credential sign again.",
      args: {
        id: tool.schema
          .string()
          .optional()
          .describe("PAT id from qoder_pat_list; omit to follow the configured credential"),
      },
      execute: (args) => Promise.resolve(reportPatSwitch(args.id, region)),
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
      execute: (args) => Promise.resolve(reportPatAdd(args.pat, args.label, args.email, region)),
    }),
    // Multi-PAT management: remove a PAT.
    qoder_pat_remove: tool({
      description:
        "Remove a stored Qoder PAT. The id must match one shown by qoder_pat_list. " +
        "If the removed PAT was active, no other PAT becomes active automatically. " +
        "Use when the user says 'remove account X' or 'delete my old PAT'.",
      args: { id: tool.schema.string().describe("PAT id from qoder_pat_list") },
      execute: (args) => Promise.resolve(reportPatRemove(args.id, region)),
    }),
    // Context tiers: what each model offers and what is currently selected.
    qoder_tier_list: tool({
      description:
        "Show each Qoder model's selectable context tiers (from the live context_config) " +
        "and any currently selected tier. The DEFAULT tier is what requests run at when " +
        "nothing is selected. Use when the user asks about 上下文档位/1M/long context or " +
        "before switching a model's context window.",
      args: {},
      execute: (_args, ctx) => Promise.resolve(reportTierList(ctx.sessionID, region)),
    }),
    // Context tiers: select a tier for THIS conversation (or clear it). `model`
    // accepts "*" to fan one tier out over every model that advertises it.
    qoder_tier_switch: tool({
      description:
        "Select a context tier for THIS conversation's Qoder model, e.g. 1000000 for the " +
        "1M window. The tier must be one of the model's advertised tiers (see " +
        "qoder_tier_list); omit it to return the conversation to its default. Pass " +
        '"*" as the model to apply the tier to every model that advertises it, or to ' +
        "clear all selections. The binding is per-conversation: this chat and its " +
        "subagents (compaction, task children) all run at the chosen tier, while a " +
        "brand-new chat still defaults. Use when the user says 'switch to 1M context' " +
        "or 'reset the context tier'.",
      args: {
        model: tool.schema
          .string()
          .describe(
            'Model id (e.g. cmodel or ultimate), or "*" for every model that advertises the tier',
          ),
        tier: tool.schema
          .number()
          .optional()
          .describe("Tier in tokens (e.g. 1000000). Omit to restore the default tier."),
      },
      execute: (args, ctx) =>
        Promise.resolve(
          reportTierSwitch(args, ctx.sessionID, region, (labelChanged) =>
            triggerCatalogRefresh(region, labelChanged),
          ),
        ),
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
      execute: (args) => Promise.resolve(reportRoutingPolicy(args, region)),
    }),
  };
}

// The campaign surface, kept as its own map so the marketing scope stays a
// separate object that disappears wholesale when the activity is withdrawn.
// Both tools are server-authoritative: eligibility, the window and the reward
// all come from the campaign response, never from a clock in here.
function campaignTools(options?: PluginOptions): Hooks["tool"] {
  return {
    qoder_campaign: tool({
      description:
        "Show the Qoder daily campaign (check-in) as the server describes it: which " +
        "accounts see it, each window's start/end, claim status and the reward. " +
        "Read-only -- it never claims. Use for 'is there a check-in today / did I " +
        "already claim'. Pass all to sweep every stored PAT instead of the active one.",
      args: {
        all: tool.schema
          .boolean()
          .optional()
          .describe("Sweep every stored PAT; defaults to the active credential only."),
      },
      execute: (args, ctx) =>
        capabilityTool("campaign", () => reportCampaigns(capabilityOptions(options), args), ctx),
    }),
    qoder_claim: tool({
      description:
        "Claim today's Qoder campaign reward(s) for accounts that report CLAIMABLE. " +
        "This spends a marketing grant: it POSTs the claim the server is currently " +
        "offering and nothing else. A window already claimed from this machine is " +
        "skipped, so it is safe to re-run. Returns a per-account verdict. Pass all to " +
        "collect across every stored PAT. reset=true clears local cooldown markers.",
      args: {
        all: tool.schema
          .boolean()
          .optional()
          .describe("Claim for every stored PAT, not just the active one."),
        reset: tool.schema
          .boolean()
          .optional()
          .describe("Clear local campaign state and return without claiming."),
      },
      execute: (args, ctx) =>
        capabilityTool("claim", () => runClaim(capabilityOptions(options), args), ctx),
    }),
  };
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  const region = regionOfPluginOptions(options);
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
        if (info.parentID === undefined && clearAllTiers(region)) {
          triggerCatalogRefresh(region, true);
        }
        return;
      }
      if (event.type === "session.deleted") {
        forgetSession(event.properties.info.id);
      }
    },
    tool: claimDisabled()
      ? capabilityTools(options)
      : { ...capabilityTools(options), ...campaignTools(options) },
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
            const region = regionOfPluginOptions(options);
            const machineID = getMachineId(region);
            const url = `${resolveEndpoints(region).manage}/device/selectAccounts?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
            return {
              url,
              instructions: "Complete the Qoder browser login, then return to opencode.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const credential = await pollDeviceFlow(codeVerifier, nonce, machineID, region);
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

// Builds one integration point. opencode's auth hook binds exactly one provider
// per plugin instance, so the international and China deployments are two
// instances of this module -- two config entries (or two shim files), each with
// its own provider id, credential store and model catalog. Everything host- or
// store-specific is resolved from the region at call time; nothing is module
// state, because both instances share the process.
//
// Two ways to select the region, and they must agree:
//   - `providerID: "qoder-cn"` in the plugin options, or
//   - `region: "cn"`.
// The provider id is the primary signal (opencode shows it to the user and uses
// it to route); `region` exists so a custom provider id can still say which
// deployment it means.
export function definePlugin(region: QoderRegion = "global") {
  const id = providerIDForRegion(region);
  const name = providerNameForRegion(region);
  return {
    // The module id must differ per instance: opencode keys loaded plugins by
    // it, so two entries sharing one id would collapse into one.
    id: region === "cn" ? "opencode-qoder-cn" : "opencode-qoder",
    setup: (ctx: PluginContext) => setupV2(ctx, region),
    server: async (_input: PluginInput, options?: PluginOptions) =>
      legacyHooks({ providerID: id, providerName: name, ...(options as object) } as PluginOptions),
  };
}

const plugin = definePlugin("global");

export default plugin;
