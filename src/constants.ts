export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_CENTER_URL = "https://center.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";

export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;

export const QODER_PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
export const USER_AGENT = "opencode-qoder";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Bundled fallback table, regenerated from the live Qoder model list.
//
// model-catalog.ts prefers the live list and only falls back to this table when
// discovery fails (no credentials, offline, upstream error, or a response shape
// we no longer understand). Keeping the numbers here accurate matters: a stale
// contextWindow silently regresses opencode's auto-compaction threshold, which
// is what made long Kimi sessions hit the gateway limit without ever compacting.
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
  input: Array<"text" | "image">;
  contextWindow: number;
  // Input budget within the default tier. Defaults to contextWindow for the
  // bundled entries; discovery fills it from max_input_tokens / context_config.
  inputWindow?: number;
  maxTokens: number;
};

export const QODER_MODELS: QoderModelDefinition[] = [
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
  {
    id: "ultimate",
    name: "Ultimate",
    reasoning: true,
    supportsEffort: true,
    efforts: ["xhigh", "high", "low", "max", "medium"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "performance",
    name: "Performance",
    reasoning: false,
    supportsEffort: true,
    efforts: ["xhigh", "high", "low", "max", "medium"],
    input: ["text", "image"],
    contextWindow: 272000,
    inputWindow: 272000,
    maxTokens: 32768,
  },
  {
    id: "efficient",
    name: "Efficient",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "lite",
    name: "Lite",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_38max",
    name: "Qwen3.8-Max",
    reasoning: true,
    supportsEffort: true,
    efforts: ["xhigh", "low", "medium"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "qfmodel",
    name: "Qwen3.8-Flash",
    reasoning: true,
    supportsEffort: true,
    efforts: ["xhigh", "low", "medium"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7-Max",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "qmodel",
    name: "Qwen3.7-Plus",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "kmodel_latest",
    name: "Kimi-K3",
    reasoning: false,
    supportsEffort: true,
    efforts: ["high", "low", "max"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "kmodel",
    name: "Kimi-K2.7-Code",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 256000,
    inputWindow: 256000,
    maxTokens: 32768,
  },
  {
    id: "gmodel",
    name: "GLM-5.3",
    reasoning: true,
    supportsEffort: true,
    efforts: ["high", "low", "max"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "gfmodel",
    name: "GLM-5.3-Flash",
    reasoning: true,
    supportsEffort: true,
    efforts: ["high", "max"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "dmodel",
    name: "DeepSeek-V4-Pro",
    reasoning: true,
    supportsEffort: true,
    efforts: ["high", "max"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "dfmodel",
    name: "DeepSeek-V4-Flash",
    reasoning: true,
    supportsEffort: true,
    efforts: ["high", "max", "low"],
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "mmodel",
    name: "MiniMax-M3",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 200000,
    inputWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_preview",
    name: "Qwen3.8 Max Preview (Qoder)",
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    inputWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gm51model",
    name: "GLM 5.2 (Qoder)",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    inputWindow: 1000000,
    maxTokens: 32768,
  },
];

// Legacy entries the live list no longer advertises but the gateway still
// accepts. Rule: no inference from a successor model -- only the live data may
// move a number, dead ids keep whatever the plugin shipped with. Re-inferred
// values were empirically wrong once already: a session on qmodel_preview ran
// fine at 313,972 total tokens, so its 1,000,000 is real and must not become
// its successor's 200,000.
