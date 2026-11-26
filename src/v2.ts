// OpenCode 2.4 plugin implementation.
//
// OpenCode 2 replaced the 1.x plugin contract: the default export is
// `Plugin.define({ id, setup })`, `ctx.catalog` split into `ctx.provider` +
// `ctx.model`, `ctx.aisdk.language()` became `ctx.aisdk.hook("language", ...)`,
// the V1 `tool` map moved to `ctx.tool.transform`, and V1's `event` /
// `chat.headers` hooks became `ctx.event.subscribe()` /
// `ctx.session.hook("model.request")`. V2 ignores a `server()` export, so
// everything the legacy path registers has to be registered again here.
//
// The request-signing logic (cosy.ts / auth.ts / claim.ts / client-version.ts)
// is shared with V1 and needs no port.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";

type V2Context = Plugin.Context;

import type { QoderProviderOptions, StoredCredential } from "./auth.js";
import { decodeOAuthRefresh } from "./auth.js";
import type { CapabilityReport } from "./capabilities.js";
import {
  capabilityError,
  reportAccount,
  reportAuth,
  reportCatalog,
  reportModel,
  reportModels,
  reportQuota,
} from "./capabilities.js";
import { refreshClientVersion, resolveClientVersion } from "./client-version.js";
import { nonEmptyString } from "./coerce.js";
import { QODER_PAT_ENV, type QoderRegion, resolveEndpoints } from "./constants.js";
import { readEnv } from "./env.js";
import { QoderLanguageModel } from "./language-model.js";
import { errorMessage, logPlugin } from "./log.js";
import {
  catalogModels,
  catalogSignature,
  type DiscoveredModel,
  discoveryDisabled,
  refreshModels,
} from "./model-catalog.js";
import { reportPatAdd, reportPatList, reportPatRemove, reportPatSwitch } from "./pat-tools.js";
import { forgetSession, recordSessionParent } from "./session-roots.js";
import { reportRoutingPolicy, reportTierList, reportTierSwitch } from "./tier-tools.js";

// V2 resolves an AI-SDK provider only when its package carries the `aisdk:`
// prefix (see AISDKNative.isAISDK in opencode v2.4). Without it the host treats
// the package as a native @opencode/ai provider and demands model(modelID,
// settings) return a V2-native LanguageModel -- which is why a plain file://
// package failed with "Schema validation failed". Marking it aisdk: routes the
// model through V2's AISDK bridge, where our sdk/language hooks install
// QoderLanguageModel (an AI SDK v3 language model).
const SDK_PACKAGE = "aisdk:opencode-qoder";

type Options = Record<string, unknown>;
// V2's tool executor rejects a result carrying `output` unless the tool was
// registered with an output schema. These capability tools declare none (their
// value is the human-readable `content` plus structured `metadata`), so never
// set `output` -- V1 needs it, V2 must not see it.
type ToolResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

function optionString(options: Options | undefined, key: string): string | undefined {
  return nonEmptyString(options?.[key]);
}

function regionOf(options: Options | undefined): QoderRegion {
  const explicit = optionString(options, "region");
  if (explicit === "cn") return "cn";
  if (explicit === "global") return "global";
  return optionString(options, "providerID") === "qoder-cn" ? "cn" : "global";
}

function providerIDFor(options: Options | undefined): string {
  return optionString(options, "providerID") ?? (regionOf(options) === "cn" ? "qoder-cn" : "qoder");
}

function providerName(options: Options | undefined): string {
  return optionString(options, "providerName") ?? "Qoder";
}

function capabilityOptions(ctx: V2Context, region: QoderRegion): QoderProviderOptions {
  const apiKey = optionString(ctx.options as Options, "apiKey");
  return apiKey ? { apiKey, region } : { region };
}

function metadataString(metadata: Record<string, unknown> | undefined, field: string) {
  const value = metadata?.[field];
  return typeof value === "string" ? value : undefined;
}

function credentialToOptions(credential: StoredCredential): QoderProviderOptions {
  const metadata = credential.metadata;
  if (credential.type === "oauth") {
    const decoded = decodeOAuthRefresh(credential.refresh || "");
    return {
      apiKey: credential.access,
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

async function connectionOptions(ctx: V2Context, id: string): Promise<QoderProviderOptions> {
  const connection = await ctx.integration.connection.active(id);
  if (!connection) return {};
  const credential = (await ctx.integration.connection.resolve(connection)) as
    | StoredCredential
    | undefined;
  return credential ? credentialToOptions(credential) : {};
}

// V2 capability tools reuse V1's report functions but return only `content`.
//
// Do NOT pass `metadata` here. Verified on OpenCode 2.4.2: when a tool result
// carries a metadata object whose values include the quota payload's nested
// structure (buckets, raw API response), the host drops the whole result and
// the model sees an empty "Tool result missing" -- even though the quota lookup
// itself succeeded. The human-readable report already lives in `content`, which
// is what the model reads, so metadata adds no value here and costs correctness.
// Also never set `output`: V2 rejects an output without a registered output
// schema ("Tool result declared output without an output schema").
function capabilityToolV2(
  name: string,
  run: () => Promise<CapabilityReport> | CapabilityReport,
): Promise<ToolResult> {
  return Promise.resolve(run())
    .then((report) => ({
      content: report.output,
    }))
    .catch((error) => {
      const failed = capabilityError(name, error);
      return { content: failed.output };
    });
}

// Wrap a raw CapabilityReport from the PAT/tier/routing tools into the V2 envelope.
function reportResult(report: CapabilityReport): ToolResult {
  return {
    content: report.output,
  };
}

type Run = (input: Record<string, unknown>, sessionID: string) => Promise<ToolResult> | ToolResult;
export type ToolSpec = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  run: Run;
};

function toolSpecs(ctx: V2Context, region: QoderRegion): ToolSpec[] {
  const opts = capabilityOptions(ctx, region);
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const idSchema = {
    type: "object",
    properties: { id: { type: "string", description: "PAT id from qoder_pat_list" } },
    required: ["id"],
    additionalProperties: false,
  };
  const specs: ToolSpec[] = [
    {
      name: "qoder_quota",
      description:
        "Read the Qoder account's remaining credits: per-bucket balance, total left, whether credits are exhausted, plan usage and renewal date. Use when the user asks about 额度/配额/余额/credits or whether they can still afford a paid model.",
      input: empty,
      run: () => capabilityToolV2("quota", () => reportQuota(opts)),
    },
    {
      name: "qoder_account",
      description:
        "Read the Qoder account profile the current credential belongs to: name, email, user and organisation IDs, registration source. Use when the user asks which Qoder account is in use.",
      input: empty,
      run: () => capabilityToolV2("account", () => reportAccount(opts)),
    },
    {
      name: "qoder_models",
      description:
        "List every Qoder model opencode is currently offering: id, credit multiplier, limits, thinking-effort levels, reasoning flag, and an Unavailable marker when credits are drained. Use when the user asks which models exist or which are cheapest.",
      input: empty,
      run: () => capabilityToolV2("models", () => reportModels(opts)),
    },
    {
      name: "qoder_model",
      description:
        "Show one Qoder model's details by id: limits, thinking efforts, credit multiplier, and where its definition came from. An unknown id resolves to the fallback model and says so.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Model id, e.g. cmodel or qmodel_38max" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input) => capabilityToolV2("model", () => reportModel(String(input.id ?? ""), region)),
    },
    {
      name: "qoder_catalog",
      description:
        "Show Qoder model-catalog diagnostics: whether the table came from the live API, disk cache or bundled fallback; when it was fetched; the cache path; whether discovery is disabled. Use when a model is missing or stale.",
      input: empty,
      run: () => capabilityToolV2("catalog", () => reportCatalog(region)),
    },
    {
      name: "qoder_auth",
      description:
        "Show which Qoder credential layer is in effect and what it resolves to -- identity and expiry only, never the token itself. Use when requests fail with auth errors.",
      input: empty,
      run: () => capabilityToolV2("auth", () => reportAuth(opts)),
    },
    {
      name: "qoder_pat_list",
      description: "List all stored Qoder PATs and which one is active.",
      input: empty,
      run: () => Promise.resolve(reportResult(reportPatList(region))),
    },
    {
      name: "qoder_pat_switch",
      description:
        "Switch the active Qoder PAT. Omit the id to clear the explicit switch and follow the configured credential again.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "PAT id from qoder_pat_list" } },
        additionalProperties: false,
      },
      run: (input) =>
        Promise.resolve(reportResult(reportPatSwitch(nonEmptyString(input.id), region))),
    },
    {
      name: "qoder_pat_add",
      description: "Add a new Qoder PAT to the store. The first PAT becomes active automatically.",
      input: {
        type: "object",
        properties: {
          pat: { type: "string", description: "The Personal Access Token (pt-...)" },
          label: { type: "string", description: "Human-readable label" },
          email: { type: "string", description: "Account email (optional)" },
        },
        required: ["pat", "label"],
        additionalProperties: false,
      },
      run: (input) =>
        Promise.resolve(
          reportResult(
            reportPatAdd(
              String(input.pat ?? ""),
              String(input.label ?? ""),
              nonEmptyString(input.email),
              region,
            ),
          ),
        ),
    },
    {
      name: "qoder_pat_remove",
      description: "Remove a stored Qoder PAT by id.",
      input: idSchema,
      run: (input) =>
        Promise.resolve(reportResult(reportPatRemove(String(input.id ?? ""), region))),
    },
    {
      name: "qoder_tier_list",
      description:
        "Show each Qoder model's selectable context tiers and the tier currently selected for this conversation.",
      input: empty,
      run: (_input, sessionID) => Promise.resolve(reportResult(reportTierList(sessionID, region))),
    },
    {
      name: "qoder_tier_switch",
      description:
        "Select a context tier for THIS conversation's Qoder model. Pass '*' as the model to apply to every model that advertises the tier; omit tier to reset to default.",
      input: {
        type: "object",
        properties: {
          model: { type: "string", description: 'Model id, or "*" for every model' },
          tier: { type: "number", description: "Tier in tokens (e.g. 1000000)" },
        },
        required: ["model"],
        additionalProperties: false,
      },
      run: (input, sessionID) =>
        Promise.resolve(
          reportResult(
            reportTierSwitch(
              {
                model: String(input.model ?? ""),
                tier: typeof input.tier === "number" ? input.tier : undefined,
              },
              sessionID,
              region,
              () => false,
            ),
          ),
        ),
    },
    {
      name: "qoder_routing_policy",
      description:
        "Show or set the subagent routing policy -- which model serves pinned helpers above the default tier.",
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          subagentModel: { type: "string" },
          target: { type: "string" },
          threshold: { type: "number" },
          exemptAgents: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      run: (input) => Promise.resolve(reportResult(reportRoutingPolicy(input as never, region))),
    },
  ];

  return specs;
}

function registerToolsV2(ctx: V2Context, region: QoderRegion, extraSpecs: ToolSpec[] = []): void {
  void ctx.tool
    .transform((tools) => {
      for (const spec of [...toolSpecs(ctx, region), ...extraSpecs]) {
        tools.add({
          name: spec.name,
          description: spec.description,
          input: spec.input as never,
          // V2's Tool.snapshot moves every tool whose `options.codemode` is not
          // explicitly false into Code Mode, where it is reachable only through
          // the `execute` program rather than as a direct tool the model can
          // call by name. These capability tools are meant to be called directly
          // (qoder_quota, qoder_pat_switch, ...), so opt them out.
          options: { codemode: false },
          execute: async (input: Record<string, unknown>, toolCtx: { sessionID?: string }) =>
            (await spec.run(input, toolCtx.sessionID ?? "")) as never,
        } as never);
      }
    })
    .catch((error) => logPlugin(`v2 tool: registration failed (${errorMessage(error)})`));
}

// V2's ctx.skill.transform has no source(directory): register each bundled
// SKILL.md with its content, matching what the 1.x directory source produced.
function registerBundledSkillsV2(ctx: V2Context, campaignDir: string | undefined): void {
  if (readEnv("QODER_DISABLE_BUNDLED_SKILL")) return;
  const dirs = [
    fileURLToPath(new URL("../skills/", import.meta.url)),
    ...(campaignDir ? [campaignDir] : []),
  ];
  void ctx.skill
    .transform((skills) => {
      for (const dir of dirs) {
        let names: string[] = [];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const skillDir = join(dir, name);
          let content: string;
          try {
            content = readFileSync(join(skillDir, "SKILL.md"), "utf8");
          } catch {
            continue;
          }
          const front = frontmatter(content);
          skills.add({
            id: `${basename(dir)}-${name}` as never,
            name: (front.name ?? name) as never,
            description: front.description ?? "",
            path: skillDir as never,
            content,
          });
        }
      }
    })
    .then(() => ctx.skill.reload())
    .catch((error) => logPlugin(`v2 skill: registration failed (${errorMessage(error)})`));
}

function frontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const eq = line.indexOf(":");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "name" || key === "description") out[key] = value;
  }
  return out;
}

function modelConfigV2(model: DiscoveredModel, region: QoderRegion): Record<string, unknown> {
  return {
    name: model.name,
    family: model.id,
    api: {
      id: model.id,
      type: "aisdk",
      package: SDK_PACKAGE,
      url: resolveEndpoints(region).baseUrl,
      settings: {},
    },
    capabilities: { tools: true, input: model.input, output: ["text"] },
    variants: (model.efforts ?? []).map((effort) => ({
      id: effort,
      headers: {},
      body: { reasoningEffort: effort },
    })),
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: {
      context: model.contextWindow,
      input: model.inputWindow ?? model.contextWindow,
      output: model.maxTokens,
    },
  };
}

export async function setupV24(
  ctx: V2Context,
  region: QoderRegion,
  campaignSpecs: ToolSpec[] = [],
  campaignDir?: string,
): Promise<() => void> {
  const options = ctx.options as Options;
  const id = providerIDFor(options);
  logPlugin(`setup[v2.4]: pid=${process.pid} region=${region} provider=${id}`);

  await ctx.integration.transform((integrations) => {
    integrations.update(id, (integration) => {
      integration.name = providerName(options);
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

  await ctx.provider.transform((providers) => {
    providers.update(id, (provider) => {
      provider.name = providerName(options);
      provider.integrationID = id as never;
      // V2 provider carries the SDK package directly; the model-level api below
      // carries the same package plus the base URL, which is what the host reads
      // when resolving the language model.
      provider.package = SDK_PACKAGE;
      provider.body = {};
      provider.headers = {};
      provider.settings = {};
      const apiKey = optionString(options, "apiKey");
      if (apiKey) provider.body.apiKey = apiKey;
    });
  });

  await ctx.model.transform((models) => {
    for (const model of catalogModels(region)) {
      models.update(id, model.id, (draft) => {
        Object.assign(draft, modelConfigV2(model, region));
      });
    }
    if (options.setDefault !== false) models.default.set(id, "auto");
  });

  registerToolsV2(ctx, region, campaignSpecs);
  registerBundledSkillsV2(ctx, campaignDir);

  // The sdk hook supplies a provider SDK with a languageModel() factory. V2's
  // AISDK bridge calls it when a language hook does not override the model; it
  // is also the place the host validates that an AISDK provider actually
  // returned something usable. Our factory produces the same signed model.
  await ctx.aisdk.hook(
    "sdk",
    (event) => {
      if (event.model.providerID !== id) return;
      event.sdk = {
        languageModel: (modelID: string) => new QoderLanguageModel(modelID, event.options as never),
      };
    },
    { providerID: id },
  );

  await ctx.aisdk.hook(
    "language",
    async (event) => {
      if (event.model.providerID !== id) return;
      const connection = await connectionOptions(ctx, id).catch(() => ({}) as QoderProviderOptions);
      const apiKey =
        connection.apiKey ||
        optionString(options, "apiKey") ||
        nonEmptyString((event.options as Record<string, unknown>).apiKey);
      const modelID =
        (event.model as { api?: { id?: string } }).api?.id ?? String(event.model.modelID);
      event.language = new QoderLanguageModel(modelID, {
        ...event.options,
        ...connection,
        apiKey,
      }) as never;
    },
    { providerID: id },
  );

  await ctx.session.hook(
    "model.request",
    (event) => {
      if (event.model.providerID !== id) return;
      if (event.agent !== "") event.headers["x-qoder-agent"] = event.agent;
      event.headers["x-qoder-session"] = event.sessionID;
    },
    { providerID: id },
  );

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      // V2 events carry a `data` payload instead of V1's `properties.info`.
      // session.created exposes `sessionID` + optional `parentID`; session.deleted
      // carries the removed session's id.
      if (event.type === "session.created") {
        const data = event.data as { sessionID?: string; id?: string; parentID?: string };
        const sid = data.sessionID ?? data.id;
        if (!sid) continue;
        recordSessionParent(sid, data.parentID);
      } else if (event.type === "session.deleted") {
        const data = event.data as { sessionID?: string; id?: string };
        forgetSession(data.sessionID ?? data.id ?? "");
      }
    }
  })().catch(() => undefined);

  if (discoveryDisabled()) return () => controller.abort();

  const discoveryOptions = async (): Promise<QoderProviderOptions> => {
    const connection = await connectionOptions(ctx, id).catch(() => ({}) as QoderProviderOptions);
    return {
      ...(options as QoderProviderOptions),
      ...connection,
      apiKey: connection.apiKey || optionString(options, "apiKey"),
    };
  };

  const reloadCatalog = async (force: boolean): Promise<void> => {
    const before = catalogSignature(region);
    const status = await refreshModels(await discoveryOptions(), force);
    if (status.source !== "qoder") return;
    if (catalogSignature(region) === before) return;
    await ctx.model.reload();
    await ctx.provider.reload();
  };

  const logFailure = (error: unknown) => logPlugin(`v2 refresh: failed (${errorMessage(error)})`);
  const warm = setTimeout(() => {
    refreshClientVersion()
      .then(() => reloadCatalog(true))
      .catch(logFailure);
  }, 0);
  warm.unref?.();
  const timer = setInterval(
    () => {
      const before = resolveClientVersion();
      refreshClientVersion()
        .then((after) => reloadCatalog(after !== before))
        .catch(logFailure);
    },
    15 * 60 * 1000,
  );
  timer.unref?.();

  return () => {
    controller.abort();
    clearInterval(timer);
  };
}

export function defineV2(region: QoderRegion) {
  return Plugin.define({
    id: region === "cn" ? "opencode-qoder-cn" : "opencode-qoder",
    async setup(ctx) {
      return setupV24(ctx as V2Context, region);
    },
  });
}
