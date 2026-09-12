export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";
// The centre host owns the refresh_token endpoint. Separated from OPENAPI
// because the two are different hosts upstream: every job-token endpoint
// (exchange, userinfo, quota) lives on openapi.qoder.sh, while the OAuth-ish
// refresh of a device-flow token lives on center.qoder.sh. Reference:
// pi-provider-qoder's getQoderRefreshURL() = `${centerUrl}/algo/api/v3/user/refresh_token`.
export const QODER_CENTER_URL = "https://center.qoder.sh";

export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_QUOTA_URL = `${QODER_OPENAPI_URL}/api/v2/quota/usage`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;

export const QODER_PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
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
