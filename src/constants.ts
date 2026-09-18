export const PROVIDER_ID = "qoder";
export const PROVIDER_ID_CN = "qoder-cn";
export const PROVIDER_NAME = "Qoder";
export const PROVIDER_NAME_CN = "Qoder (CN)";

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------
// The plugin serves two Qoder deployments that share a protocol but not a
// single host: the international site (qoder.sh) and the China site
// (qoder.com.cn). opencode's auth hook binds exactly one provider per plugin
// instance, so each region is its own instance -- two plugin entries in the
// config, two provider ids, two credential stores. Nothing here is module
// state: the same process hosts both, so region must always travel as a
// parameter (see resolveEndpoints / stateFiles).
//
// UNVERIFIED: the international hosts below are exercised in production; every
// QODER_CN_* host and path is copied from community implementations
// (dsh-provider-qoder's region table, qoder-proxy's login refresh path) and has
// never been reached with a real CN account. Treat CN as experimental until
// someone runs it against one.
//
// An international PAT is actively REJECTED by the CN hosts (exchange answers
// 400, the CN quota endpoint answers 401), so a CN run that succeeds is a red
// flag, not a green one: it means the region never reached the request. That is
// exactly what happened once -- `--region=cn` walked the CN store but dialed the
// international host because region was dropped when the request options were
// built. Region is not a display setting; it must reach every network call, and
// quota-cli.test.ts now asserts the HOST for this reason.
export type QoderRegion = "global" | "cn";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";
// The centre host owns the refresh_token endpoint. Separated from OPENAPI
// because the two are different hosts upstream: every job-token endpoint
// (exchange, userinfo, quota) lives on openapi.qoder.sh, while the OAuth-ish
// refresh of a device-flow token lives on center.qoder.sh. Reference:
// pi-provider-qoder's getQoderRefreshURL() = `${centerUrl}/algo/api/v3/user/refresh_token`.
export const QODER_CENTER_URL = "https://center.qoder.sh";

export const QODER_CN_BASE_URL = "https://gateway.qoder.com.cn/";
export const QODER_CN_OPENAPI_URL = "https://openapi.qoder.com.cn";
export const QODER_CN_MANAGE_URL = "https://qoder.com.cn";
// The China deployment serves its center APIs off the SAME host as the model
// gateway (gateway.qoder.com.cn), unlike the international site where center
// and gateway are different hosts. That is why the table below cannot derive
// center from base by one rule.
export const QODER_CN_CENTER_URL = "https://gateway.qoder.com.cn";

export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_QUOTA_URL = `${QODER_OPENAPI_URL}/api/v2/quota/usage`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;

// Every local state file the plugin owns, named per region. The two regions
// share one config directory, so a shared name would let a CN login overwrite
// an international PAT store (or a CN tier selection move the international
// picker). The machine id is included for the same reason: it is a signing
// input, and the two deployments' servers must not see one machine identity.
//
// The international names are the historical ones, kept byte-identical so an
// existing install keeps its credentials after the upgrade.
export interface QoderStateFiles {
  pats: string;
  models: string;
  tiers: string;
  routing: string;
  claim: string;
  machineId: string;
}

export function stateFiles(region: QoderRegion): QoderStateFiles {
  if (region === "cn") {
    return {
      pats: "qoder-cn-pats.json",
      models: "opencode-qoder-cn-models.json",
      tiers: "qoder-cn-tiers.json",
      routing: "qoder-cn-routing.json",
      claim: "qoder-cn-claim.json",
      machineId: "qoder-cn-machine-id",
    };
  }
  return {
    pats: "qoder-pats.json",
    models: "opencode-qoder-models.json",
    tiers: "qoder-tiers.json",
    routing: "qoder-routing.json",
    claim: "qoder-claim.json",
    machineId: "qoder-machine-id",
  };
}

// The globalThis channel keys. Both regions in one process share globalThis, so
// an unscoped key would have the CN store overwrite the international one --
// and opencode loads each provider twice (legacy + v2 realm), which makes the
// collision reachable from ordinary use, not just a corner case.
export function sharedKey(name: string, region: QoderRegion): string {
  return region === "global" ? `__opencode_qoder_${name}` : `__opencode_qoder_${region}_${name}`;
}

export function regionOfProviderID(providerID: string | undefined): QoderRegion {
  return providerID === PROVIDER_ID_CN ? "cn" : "global";
}

export function providerIDForRegion(region: QoderRegion): string {
  return region === "cn" ? PROVIDER_ID_CN : PROVIDER_ID;
}

export function providerNameForRegion(region: QoderRegion): string {
  return region === "cn" ? PROVIDER_NAME_CN : PROVIDER_NAME;
}

// Every host-derived URL one region needs, resolved in one place. Callers take
// a region and read fields off this; they must never re-concatenate a host
// inline, because that is how the two regions silently diverge.
export interface QoderEndpoints {
  baseUrl: string;
  openapi: string;
  center: string;
  manage: string;
  modelList: string;
  chat: string;
  exchange: string;
  userinfo: string;
  /** Refresh of a device-flow token. */
  refresh: string;
  quota: string;
  campaigns: string;
  /** Device-flow poll; the login flow appends nonce/verifier/challenge_method. */
  devicePoll: string;
}

const CHAT_PATH =
  "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const MODEL_LIST_PATH = "algo/api/v2/model/list";

export function resolveEndpoints(region: QoderRegion): QoderEndpoints {
  if (region === "cn") {
    const base = QODER_CN_BASE_URL;
    const openapi = QODER_CN_OPENAPI_URL;
    const center = QODER_CN_CENTER_URL;
    return {
      baseUrl: base,
      openapi,
      center,
      manage: QODER_CN_MANAGE_URL,
      modelList: `${base}${MODEL_LIST_PATH}`,
      chat: `${base}${CHAT_PATH}`,
      exchange: `${openapi}/api/v1/jobToken/exchange`,
      userinfo: `${openapi}/api/v1/userinfo`,
      // The China site refreshes a device-flow token on a different path from
      // the international one. Reference: @hangox/qoder-proxy, which drives CN
      // login through /api/v1/deviceToken/refresh.
      refresh: `${center}/api/v1/deviceToken/refresh`,
      quota: `${openapi}/api/v2/quota/usage`,
      campaigns: `${openapi}/sash/api/v1/me/campaigns`,
      devicePoll: `${openapi}/api/v1/deviceToken/poll`,
    };
  }
  return {
    baseUrl: QODER_BASE_URL,
    openapi: QODER_OPENAPI_URL,
    center: QODER_CENTER_URL,
    manage: QODER_MANAGE_URL,
    modelList: QODER_MODEL_LIST_URL,
    chat: QODER_CHAT_URL,
    exchange: QODER_EXCHANGE_URL,
    userinfo: QODER_USERINFO_URL,
    refresh: QODER_REFRESH_URL,
    quota: QODER_QUOTA_URL,
    campaigns: `${QODER_OPENAPI_URL}/sash/api/v1/me/campaigns`,
    devicePoll: `${QODER_OPENAPI_URL}/api/v1/deviceToken/poll`,
  };
}

export const QODER_PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
// --- promotional campaign surface ("签到领积分") ------------------------------
//
// The daily reward endpoints qodercli's `/claim` drives. Isolated on purpose:
// this is a MARKETING activity, not a product API, so it is allowed to vanish
// between two calls (observed live: the same account went from one CLAIMED
// campaign to `showCampaign:false` in 25 minutes). Nothing on the model, chat,
// catalog or quota path may import claim.ts -- the dependency runs one way, and
// a test in __tests__/claim.test.ts fails the build if that ever inverts.
//
// Reference: GET /sash/api/v1/me/campaigns then POST .../campaigns/{id}/claim,
// both plain Bearer on the OpenAPI host -- the same auth shape as QODER_QUOTA_URL.
export const QODER_CAMPAIGNS_URL = `${QODER_OPENAPI_URL}/sash/api/v1/me/campaigns`;
// Master switch for the whole promotional surface: set to 0/off/false/none and
// the claim tools stop being registered AND the campaign skill stops being
// offered, so `/qoder-claim` disappears instead of lingering as a dead command.
// Read on every call, never cached at import -- turning an abandoned campaign
// off must not need a rebuild or a restart.
export const QODER_CLAIM_ENV = "OPENCODE_QODER_CLAIM";
// A promo host must never hold a conversation turn open for as long as the
// model list or quota call is allowed to.
export const QODER_CLAIM_TIMEOUT_MS = 10 * 1000;
// Multi-PAT bootstrap import. Deliberately NOT part of QODER_PAT_ENV: this is
// not a credential-resolution layer (the chain still ends at the two env vars
// above). At plugin setup its value is SPLIT on `,`/`;` and IMPORTED into the
// pat-store, after which the store -- not the variable -- is what authenticates
// requests. Keeping it out of QODER_PAT_ENV also keeps it out of the `env`
// auth-method broadcast (index.ts) and the qoder_auth layer table. The name
// carries the plugin's own prefix so it can never collide with an official Qoder
// CLI variable: QODER_PERSONAL_ACCESS_TOKEN stays single-PAT and
// official-CLI-compatible, exactly as before.
export const QODER_PAT_IMPORT_ENV = "OPENCODE_QODER_PAT";
// The seed key file: the plugin-owned replacement for opencode's
// `{file:...}` apiKey option, so the file's LOCATION never has to appear in
// config (the option is resolved by opencode before the plugin sees it, which
// is why an absolute path was the only spelling there). Default
// `~/.qoderkey_env`, resolved with homedir() and therefore portable; override
// with the `keyFile` provider option or this env var, disable with "none".
// The grammar decides the role (classifyImportValue in pat-import.ts): a bare
// single token is a credential; a list (`,`/`;`/newline, or an
// `OPENCODE_QODER_PAT=` assignment) seeds the pat-store exactly like the env
// import above does -- except the file is live, re-read when its mtime moves.
export const QODER_KEY_FILE_ENV = "OPENCODE_QODER_KEY_FILE";
export const QODER_KEY_FILE_DEFAULT = ".qoderkey_env";
export const USER_AGENT = "opencode-qoder";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Defaults for an incomplete identity profile. credentialsFromPat(),
// resolveQoderCredentials() and the device-flow login all synthesize a
// QoderCredentials, and all three used to repeat the same triple inline.
export const QODER_DEFAULT_USER_ID = "qoder-user";
export const QODER_DEFAULT_EMAIL = "user@qoder.com";
export const QODER_DEFAULT_NAME = "Qoder User";

// Tokens are treated as expired this long before their actual deadline, so a
// request never starts with a token that dies mid-flight.
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

// Fallback lifetime for a device-flow token that reports no expiry at all.
// Unlike the exchange endpoints this one is answered in SECONDS.
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Whole-request timeout shared by every JSON endpoint this plugin calls
// (model list, quota). Excluded from here: chat streams, which stay open for
// the life of a response, and the credential exchange, which is quick but
// unbounded on purpose so a slow upstream never truncates a login.
export const FETCH_TIMEOUT_MS = 15 * 1000;

// Client identity sent on authenticated Qoder requests. The api3.qoder.sh COSY
// surface (cosy.ts: header + signed payload field) and the openapi.qoder.sh
// JSON calls (auth.ts) both consume it.
//
// Value pinned to the reference client by reading qodercli's own bundle: it sets
// `Cosy-Version = <its package version>` (ItA = BSA || "1.1.42") and uses that
// single value everywhere it injects identity headers — there is no 1.0.x in the
// real client. The token-exchange POSTs don't send Cosy-Version at all, so it is
// advisory/telemetry: nothing here gates on it, but matching a current real
// client is the safe default. Earlier values (1.0.0 on COSY, 1.0.1 on openapi)
// were stale guesses. Bump this to track qodercli when convenient; it is not a
// correctness dependency.
export const QODER_VERSION = "1.1.42";
export const QODER_CLIENT_TYPE = "5";

// The model-definition shape shared by the static fallback table
// (static-models.ts) and live discovery (model-catalog.ts).
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
  // Every context tier the gateway advertises for this model (token counts,
  // ascending), from context_config.*.token_count. Undefined when upstream
  // carries no context_config or fewer than two usable windows. The DEFAULT
  // tier is what contextWindow/inputWindow report; a selected tier rides
  // parameters.context_length on the chat request (see tier-store.ts).
  contextTiers?: number[];
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

// The bundled fallback table itself lives in static-models.ts, which owns the
// env -> user -> shipped read order and per-entry validation. When editing
// models.json by hand: only live data may move a contextWindow. Do not infer
// one from a successor model -- re-inferred values were empirically wrong once
// already (a retired preview id genuinely ran at 313,972 tokens, so copying its
// successor's 200,000 would have broken it). A dead id keeps whatever number
// was last observed live, or is dropped entirely.

// Upstream error codes returned in the `code` field of a failed response body.
// The chat endpoint wraps these in its own JSON envelope; the plugin detects
// them and rewrites the raw HTTP error into a user-facing message.
export const QODER_ERROR_CODE_QUOTA_EXHAUSTED = "112";
// "Login expired". NOT a token lifetime: this is what the gateway answers when
// the identity inside the COSY payload is not the real account uid -- most
// easily when a placeholder uid was signed because userinfo resolution failed
// (pi-provider-qoder documents the same failure in resolveQoderIdentity()).
// Also the code to treat as "the credential this request was signed with is
// dead", so it is the trigger for invalidating the exchange cache and retrying.
export const QODER_ERROR_CODE_LOGIN_EXPIRED = "105";
