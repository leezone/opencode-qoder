import crypto from "node:crypto";
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import {
  identityUnresolved as identityMissing,
  type QoderCredentials,
  type QoderProviderOptions,
  refreshQoderCredentials,
  resolveQoderCredentials,
  signingUserID,
} from "./auth.js";
import {
  QODER_CHAT_URL,
  QODER_ERROR_CODE_LOGIN_EXPIRED,
  QODER_ERROR_CODE_QUOTA_EXHAUSTED,
  USER_AGENT,
} from "./constants.js";
import { buildAuthHeaders } from "./cosy.js";
import { qoderEncodeBody } from "./encoding.js";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";
import { getModelDefinition, isValidContextTier } from "./model-catalog.js";
import { getRoutingPolicy, resolveRouting } from "./routing-policy.js";
import { resolveRootSession } from "./session-roots.js";
import { getSelectedTier, getSessionTier } from "./tier-store.js";
import { type QoderMessage, type QoderTool, transformPrompt, transformTools } from "./transform.js";

// ---------------------------------------------------------------------------
// Upstream error → user-friendly APICallError
// ---------------------------------------------------------------------------
// The chat endpoint wraps errors in JSON like:
//   {"code":"112","message":"{\"pricingUrl\":\"...\"}"}
// parseQoderHttpError tries to extract the code and rewrites the message so
// opencode can display it nicely (APICallError is the AI SDK standard).
// ---------------------------------------------------------------------------

type QoderUpstreamBody = { code?: string; message?: string };

/**
 * An upstream failure that carries Qoder's own error code, from either place
 * that code can arrive: the HTTP body, or an in-band SSE envelope on a
 * response whose HTTP status was 200. The distinction matters because the
 * in-band form -- `{"statusCodeValue":403,"body":"{\"code\":\"105\",...}"}` --
 * never reaches the HTTP error path, so without this type the one signal that
 * says "this credential is dead" is thrown away as a plain Error string.
 */
export class QoderUpstreamError extends Error {
  readonly statusCode: number;
  readonly code: string | undefined;
  /** True when the identity signed into the COSY payload was a placeholder. */
  readonly identityUnresolved: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string | undefined,
    identityUnresolved = false,
  ) {
    super(message);
    this.name = "QoderUpstreamError";
    this.statusCode = statusCode;
    this.code = code;
    this.identityUnresolved = identityUnresolved;
  }

  /**
   * The gateway saying our credential is no longer good: an auth-ish HTTP
   * status, or its in-band equivalent, or the "Login expired" code on its own.
   * This is the trigger to drop the cached exchange and get a new credential
   * rather than replay a dead one -- see QoderLanguageModel.doStream().
   */
  get isAuthFailure(): boolean {
    if (this.code === QODER_ERROR_CODE_LOGIN_EXPIRED) return true;
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

function parseQoderUpstreamBody(text: string): QoderUpstreamBody | undefined {
  try {
    const outer = JSON.parse(text) as Record<string, unknown>;
    if (typeof outer.code === "string") return outer as QoderUpstreamBody;
    if (typeof outer.message === "string") {
      try {
        const inner = JSON.parse(outer.message) as Record<string, unknown>;
        if (typeof inner.code === "string") return inner as QoderUpstreamBody;
      } catch {
        /* message is plain text, not nested JSON */
      }
    }
  } catch {
    /* not JSON at all */
  }
  return undefined;
}

function buildQoderErrorMessage(status: number, body: string): string {
  const parsed = parseQoderUpstreamBody(body);
  if (parsed?.code === QODER_ERROR_CODE_QUOTA_EXHAUSTED) {
    return "Qoder credits exhausted — free quota used up. Upgrade at https://qoder.com/pricing";
  }
  if (parsed?.code === QODER_ERROR_CODE_LOGIN_EXPIRED) {
    // Names the failure in actionable terms but keeps the upstream wording
    // verbatim, so a user searching for the message they saw finds this.
    return `Qoder rejected the credential — ${parsed.message || "Login expired"} (code 105)`;
  }
  if (parsed?.code && parsed?.message) {
    return `Qoder API error (code ${parsed.code}): ${parsed.message}`;
  }
  return `Qoder API error ${status}`;
}

// Whether an arbitrary thrown value is the gateway rejecting our credential.
// Both shapes of that rejection matter: an HTTP 401/403 (an APICallError from
// throwQoderApiError) and the in-band envelope on a 200 response (a
// QoderUpstreamError) -- the latter is the one that actually fires for "Login
// expired", because the chat endpoint wraps the 403 inside an SSE frame.
export function isQoderAuthFailure(error: unknown): boolean {
  if (error instanceof QoderUpstreamError) return error.isAuthFailure;
  if (error instanceof APICallError) return error.statusCode === 401 || error.statusCode === 403;
  return false;
}

/**
 * The final error for a rejection no credential renewal cleared, said as plainly
 * as possible. When the signed uid was the placeholder, that -- not the token's
 * expiry -- is the cause, and it is invisible upstream: the gateway just says
 * "Login expired". The renewal path has already been tried and failed here, so
 * the actionable step is a fresh login, and the message has to be the only place
 * the diagnosis survives.
 */
function authFailureError(error: unknown, credentials: QoderCredentials): unknown {
  if (!identityMissing(credentials.userID)) return error;
  logPlugin("chat: auth rejection with an unresolved account uid -- a placeholder uid was signed");
  return new Error(
    `Qoder rejected this request as "Login expired" and the credential carried no ` +
      `resolvable account uid (userinfo returned nothing, so a placeholder was signed). ` +
      `Re-run /connect qoder, or check QODER_PERSONAL_ACCESS_TOKEN. ` +
      `Original error: ${errorMessage(error)}`,
  );
}

function throwQoderApiError(status: number, url: string, body: string): never {
  const message = buildQoderErrorMessage(status, body);
  const error = new APICallError({
    message,
    url,
    requestBodyValues: undefined,
    statusCode: status,
    responseBody: body,
    isRetryable: false,
    data: parseQoderUpstreamBody(body),
  });
  // Ensure opencode sees a clear message even if it wraps the error.
  Object.defineProperty(error, "name", { value: "QoderAPIError", configurable: true });
  throw error;
}

type ToolCallState = {
  // Undefined until the upstream id arrives (or startToolCall fabricates one).
  id?: string;
  // True once an id streamed in from upstream, as opposed to a fabricated one.
  upstreamID: boolean;
  name: string;
  arguments: string;
  started: boolean;
  finished: boolean;
  // Argument deltas received before the id was known; flushed on start.
  pendingDeltas: string[];
};

type QoderChunk = {
  id?: string;
  model?: string;
  created?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

const THINKING_TAG_VARIANTS = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: QoderMessage[],
  tools: QoderTool[],
  maxTokens: number,
): string {
  // stableHash NUL-separates each input, so a message folds its role, content
  // and tool_calls into ONE input: that keeps the digest byte-identical to the
  // previous hand-rolled hashing (verified over 10 adversarial inputs, incl.
  // NULs inside content and cross-field boundary crafts).
  const inputs = [model, ...messages.map(recordMessageInput)];
  if (tools.length) inputs.push(JSON.stringify(tools));
  inputs.push(`mt=${maxTokens}`);
  return stableHash("qoder-record", ...inputs);
}

function recordMessageInput(message: QoderMessage): string {
  let input = message.role;
  if (message.content) {
    input +=
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  }
  if (message.tool_calls) input += JSON.stringify(message.tool_calls);
  return input;
}

function mapFinishReason(
  raw: string | undefined,
  hasToolCalls: boolean,
): LanguageModelV3FinishReason {
  if (hasToolCalls || raw === "tool_calls" || raw === "function_call")
    return { unified: "tool-calls", raw };
  if (raw === "length") return { unified: "length", raw };
  if (raw === "content_filter") return { unified: "content-filter", raw };
  if (!raw || raw === "stop") return { unified: "stop", raw };
  return { unified: "other", raw };
}

function usageFromQoder(raw?: QoderChunk["usage"]): LanguageModelV3Usage {
  const promptTokens = raw?.prompt_tokens;
  const cachedTokens = raw?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: {
      total: promptTokens,
      noCache:
        promptTokens !== undefined && cachedTokens !== undefined
          ? promptTokens - cachedTokens
          : undefined,
      cacheRead: cachedTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: raw?.completion_tokens,
      text: undefined,
      reasoning: raw?.completion_tokens_details?.reasoning_tokens,
    },
    raw,
  };
}

function isParsableJson(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags)
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  return maxLength;
}

class StreamEmitter {
  private textID: string | undefined;
  private reasoningID: string | undefined;
  private textIndex = 0;

  constructor(private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {}

  text(delta: string): void {
    if (!delta) return;
    this.endReasoning();
    if (!this.textID) {
      this.textID = `txt-${this.textIndex++}`;
      this.controller.enqueue({ type: "text-start", id: this.textID });
    }
    this.controller.enqueue({ type: "text-delta", id: this.textID, delta });
  }

  endText(): void {
    if (!this.textID) return;
    this.controller.enqueue({ type: "text-end", id: this.textID });
    this.textID = undefined;
  }

  reasoning(delta: string): void {
    if (!delta) return;
    if (!this.reasoningID) {
      this.endText();
      this.reasoningID = "reasoning-0";
      this.controller.enqueue({ type: "reasoning-start", id: this.reasoningID });
    }
    this.controller.enqueue({ type: "reasoning-delta", id: this.reasoningID, delta });
  }

  endReasoning(): void {
    if (!this.reasoningID) return;
    this.controller.enqueue({ type: "reasoning-end", id: this.reasoningID });
    this.reasoningID = undefined;
  }

  closeOpenBlocks(): void {
    this.endReasoning();
    this.endText();
  }
}

class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private activeEndTag = THINKING_TAG_VARIANTS[0].close;

  constructor(private emitter: StreamEmitter) {}

  process(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.thinkingExtracted) {
        this.emitter.text(this.textBuffer);
        this.textBuffer = "";
        break;
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (!this.textBuffer) return;
    if (this.inThinking) {
      this.emitter.reasoning(this.textBuffer);
      this.emitter.endReasoning();
    } else {
      this.emitter.text(this.textBuffer);
    }
    this.textBuffer = "";
  }

  private processBeforeThinking(): void {
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | undefined;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }

    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitter.text(this.textBuffer.slice(0, bestPos));
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }

    // Never emit a trailing fragment that could be the start of a tag we have
    // not seen the beginning of yet.
    this.flushSafePrefix(
      getMaxTrailingPossibleTagPrefixLength(
        this.textBuffer,
        THINKING_TAG_VARIANTS.map((variant) => variant.open),
      ),
      (text) => this.emitter.text(text),
    );
  }

  // Emit everything except the last `tailLength` chars, which may still turn
  // out to be a partial tag and must wait for more input.
  private flushSafePrefix(tailLength: number, emit: (text: string) => void): void {
    const safeLen = this.textBuffer.length - tailLength;
    if (safeLen <= 0) return;
    emit(this.textBuffer.slice(0, safeLen));
    this.textBuffer = this.textBuffer.slice(safeLen);
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitter.reasoning(this.textBuffer.slice(0, endPos));
      this.emitter.endReasoning();
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    this.flushSafePrefix(
      getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag),
      (text) => this.emitter.reasoning(text),
    );
  }
}

// The effort ladder qodercli itself uses when folding a max_thinking_tokens
// budget into a level (its xRE(): <=0 none, <=1024 low, <=8192 medium,
// <=24576 high, <=49152 xhigh, else max).
const EFFORT_LADDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

// Resolve the thinking strength to put on the wire.
//
// Precedence:
//   1. QODER_REASONING_EFFORT -- env override, so the gateway field can be
//      verified before the picker is trusted end to end
//   2. options.reasoningEffort -- where opencode delivers the selected variant's
//      body: v7 merges the variant body into request.body, and the aisdk bridge
//      spreads request.body into the options object passed to this constructor
//   3. options.reasoning_effort -- tolerate the snake_case spelling as well
//
// Returns undefined for models that advertise no efforts (no thinking_config), so
// their payload stays byte-identical to before this change.
function resolveReasoningEffort(
  options: LanguageModelV3CallOptions,
  model: ReturnType<typeof getModelDefinition>,
): string | undefined {
  const supported = model?.efforts ?? [];
  if (supported.length === 0) return undefined;
  const env = readEnv("QODER_REASONING_EFFORT").toLowerCase();
  if (env) return (EFFORT_LADDER as readonly string[]).includes(env) ? env : undefined;
  const optionBag = options as Record<string, unknown>;
  const picked = String(optionBag?.reasoningEffort ?? optionBag?.reasoning_effort ?? "")
    .trim()
    .toLowerCase();
  if (!picked) return undefined;
  if (!(EFFORT_LADDER as readonly string[]).includes(picked)) return undefined;
  // The picker only ever offers this model's own efforts, so anything else means
  // stale metadata. Dropping it is safer than risking a gateway 400.
  return supported.includes(picked) ? picked : undefined;
}

// Session-aware route for one request.
//
// The plugin's chat.headers hook stamps two headers on every call: X-Qoder-Agent
// (opencode's agent name, which it otherwise never forwards) and X-Qoder-Session
// (the session id, so we do not depend on opencode's native X-Session-Id name
// surviving a rename -- that one is still read as a fallback). Both are read here.
//
// A child session (task subagent, compaction) carries its own id, so the tier
// lookup resolves upward through the parent map recorded from session.created
// events; an unresolvable id simply means "no session tier" and the request
// keeps the selected model at its default. Everything degrades to the
// pre-tier wire shape when neither header is present.
function resolveRequestRoute(
  modelID: string,
  options: LanguageModelV3CallOptions,
): { modelID: string; tier: number | undefined; root: string; agent: string; session: string } {
  let agent = "";
  let qoderSession = "";
  let nativeSession = "";
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (typeof value !== "string") continue;
    const lowered = key.toLowerCase();
    if (lowered === "x-qoder-agent") agent = value;
    else if (lowered === "x-qoder-session") qoderSession = value;
    else if (lowered === "x-session-id") nativeSession = value;
  }
  const sessionID = qoderSession !== "" ? qoderSession : nativeSession;
  const root = sessionID === "" ? "" : resolveRootSession(sessionID);
  const tier = root === "" ? undefined : getSessionTier(root);
  const decision = resolveRouting({
    policy: getRoutingPolicy(),
    modelID,
    agent,
    sessionTier: tier,
    targetSupports: (id, tokens) => isValidContextTier(getModelDefinition(id), tokens),
  });
  if (decision.escalated) {
    logPlugin(
      `routing: ${agent === "" ? "?" : agent} ${modelID} -> ${decision.modelID} @${tier} (session ${root})`,
    );
  }
  // One-shot plumbing report: confirms the chat.headers identity stamps actually
  // reach doStream (opencode loads this in a separate realm from the hook, so
  // "did it arrive?" is a real question this answers once instead of per call).
  if (!routeProbeLogged) {
    routeProbeLogged = true;
    logPlugin(
      `route-probe: headers=${JSON.stringify(Object.keys(options.headers ?? {}))} agent=${agent === "" ? "?" : agent} session=${sessionID === "" ? "?" : sessionID} root=${root === "" ? "?" : root}`,
    );
  }
  return { modelID: decision.modelID, tier, root, agent, session: sessionID };
}

let routeProbeLogged = false;

function buildRequestBody(
  modelID: string,
  options: LanguageModelV3CallOptions,
  sessionUID: string,
): { body: Record<string, unknown>; warnings: SharedV3Warning[] } {
  const route = resolveRequestRoute(modelID, options);
  modelID = route.modelID;
  const model = getModelDefinition(modelID);
  const transformed = transformPrompt(options.prompt);
  const { tools, ignoredTools } = transformTools(options.tools);
  const warnings: SharedV3Warning[] = [];

  if (ignoredTools > 0) warnings.push({ type: "unsupported", feature: "provider-defined tools" });
  if (options.stopSequences?.length)
    warnings.push({ type: "unsupported", feature: "stop sequences" });
  if (options.responseFormat?.type === "json")
    warnings.push({ type: "unsupported", feature: "JSON response format" });

  let maxTokens = model.maxTokens;
  if (options.maxOutputTokens && options.maxOutputTokens < maxTokens)
    maxTokens = options.maxOutputTokens;

  const recordID = stableChatRecordID(modelID, transformed.messages, tools, maxTokens);
  // session_id is upstream's cache-affinity key, so it must be stable within a
  // conversation and distinct across conversations. Both reference clients
  // (pi-provider-qoder's stream.ts, qoder-bridge's requestSessionID) combine a
  // stable per-user/model prefix with a per-conversation id, falling back to a
  // random id when no conversation id is available -- and for the same reason:
  // the gateway keeps prompt-cache state under it.
  //
  // The old code used the prefix ALONE, which was constant for a given
  // user+model, so every conversation in the process -- plus every subagent --
  // shared one upstream session and its cache. opencode's own session id
  // (X-Session-Id, or X-Qoder-Session for a subagent's) arrives on the request
  // headers and is the per-conversation part. Without it (a bare library use,
  // or a caller that strips headers) a fresh UUID is strictly better than a
  // shared constant: cache misses, but no cross-talk.
  const sessionPrefix = stableHash("qoder-session", sessionUID, modelID);
  const sessionID =
    route.session === ""
      ? `${sessionPrefix}-${crypto.randomUUID()}`
      : `${sessionPrefix}-${route.session}`;
  const parameters: Record<string, unknown> = { max_tokens: maxTokens };
  if (typeof options.temperature === "number") parameters.temperature = options.temperature;
  if (typeof options.topP === "number") parameters.top_p = options.topP;
  // Thinking strength.
  //
  // opencode delivers the selected variant as providerOptions.qoder.reasoningEffort
  // (the body it generates for @ai-sdk/openai-compatible variants).
  // Qoder's own CLI puts the value in parameters.reasoning_effort -- see
  // qodercli's `parameters:{...A.parameters, reasoning_effort:"none",
  // max_thinking_tokens:0}`. Ladder: none/low/medium/high/xhigh/max.
  //
  // Only sent when the model actually advertises efforts, so models without a
  // thinking_config (e.g. lite) keep their payload byte-identical to before.
  const effort = resolveReasoningEffort(options, model);
  if (effort) parameters.reasoning_effort = effort;

  // Context tier selection.
  //
  // When a tier other than the default is selected for this model (tier-store),
  // the request carries parameters.context_length = <token count> -- the same
  // field qodercli sends after its window picker:
  //   s?.contextWindow!==void 0 && qq(E,s.contextWindow) && (m.context_length=s.contextWindow)
  // Its qq() validator accepts the value only when it is EXACTLY one of the
  // model's advertised context_config windows (or <= max_input_tokens when
  // upstream lists no windows), so the same rule is applied here -- anything
  // else risks a gateway 400. Absent a selection, no context_length is sent
  // and the gateway applies the default tier, keeping the payload
  // byte-identical to before the feature existed.
  //
  // The session tier wins because it is conversation-bound and shared with the
  // subagents (one switch lifts the whole exchange). The per-model display
  // selection remains as the fallback for a request whose session carries no
  // tier: a manually edited store file, or a call with no resolvable session.
  // Both are re-validated against the model that ACTUALLY serves the request
  // (post-escalation), so a tier the target does not advertise is never sent.
  const selectedTier = route.tier ?? getSelectedTier(modelID);
  if (selectedTier !== undefined && isValidContextTier(model, selectedTier)) {
    parameters.context_length = selectedTier;
    logPlugin(
      `tier: ${modelID} (agent ${route.agent === "" ? "?" : route.agent}) @${selectedTier} via session ${route.root === "" ? "store-file" : route.root}`,
    );
  } else if (selectedTier !== undefined) {
    // Asked for a tier this model does not advertise: a stale store value or a
    // manual-file mistake. Silently falling back beats a gateway 400.
    logPlugin(
      `tier: ${modelID} wanted ${selectedTier} but it is not advertised -> gateway default`,
    );
  }

  return {
    warnings,
    body: {
      request_id: crypto.randomUUID(),
      request_set_id: recordID,
      chat_record_id: recordID,
      session_id: sessionID,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: transformed.system,
      messages: transformed.messages,
      tools,
      parameters,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: {
            key: modelID,
            is_reasoning: model.reasoning,
          },
          originalContent: transformed.lastUserText,
        },
        features: [],
        text: transformed.lastUserText,
      },
      model_config: {
        key: modelID,
        is_reasoning: model.reasoning,
        max_output_tokens: model.maxTokens,
        source: "system",
      },
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: crypto.randomUUID(),
        name: transformed.lastUserText.substring(0, 30),
        begin_at: Date.now(),
      },
    },
  };
}

function parseSSELine(line: string): QoderChunk | undefined {
  if (!line.startsWith("data:")) return undefined;
  const dataStr = line.substring(5).trim();
  if (!dataStr || dataStr === "[DONE]") return undefined;

  // A malformed line is dropped, not fatal: a proxy can inject or truncate one
  // mid-body, and a stream that is otherwise fine should keep rendering rather
  // than fail as a whole. Protocol-level failures (statusCodeValue) still throw
  // -- those are the upstream answering, not noise.
  let envelope: { statusCodeValue?: number; body?: string };
  try {
    envelope = JSON.parse(dataStr) as { statusCodeValue?: number; body?: string };
  } catch {
    logPlugin(`sse: dropped malformed data line (${dataStr.slice(0, 80)})`);
    return undefined;
  }
  // The envelope's status: 200 -- or absent -- proceeds; any other number is
  // an upstream failure. Written as a typeof check rather than a truthiness
  // guard so the semantics are deliberate: 0 has never been observed upstream
  // and is tolerated as "no status" instead of inventing a new failure mode,
  // while a string like "500" is treated as absent (the body parse below will
  // judge the envelope on its merits).
  const status = envelope.statusCodeValue;
  if (typeof status === "number" && status !== 0 && status !== 200) {
    // Thrown as a typed error, not a string: this envelope is how the chat
    // endpoint reports "Login expired" (403/105) -- over an HTTP 200 -- and the
    // request path needs the code to know that its credential, not the
    // conversation, is what the gateway rejected.
    const body = envelope.body ?? "";
    throw new QoderUpstreamError(
      `${buildQoderErrorMessage(status, body)} [upstream status ${status}]`,
      status,
      parseQoderUpstreamBody(body)?.code,
    );
  }
  if (!envelope.body || envelope.body === "[DONE]") return undefined;
  try {
    return JSON.parse(envelope.body) as QoderChunk;
  } catch {
    logPlugin(`sse: dropped chunk with malformed body (${envelope.body.slice(0, 80)})`);
    return undefined;
  }
}

export class QoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "qoder";
  readonly supportedUrls = { "image/*": [/^data:/, /^https?:/] };

  constructor(
    readonly modelId: string,
    private readonly providerOptions: QoderProviderOptions = {},
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options);
    const content: LanguageModelV3Content[] = [];
    const textByID = new Map<string, { type: "text"; text: string }>();
    const reasoningByID = new Map<string, { type: "reasoning"; text: string }>();
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
    let usage = usageFromQoder();
    const warnings: SharedV3Warning[] = [];

    for await (const part of result.stream) {
      if (part.type === "stream-start") warnings.push(...part.warnings);
      if (part.type === "text-start") {
        const block = { type: "text" as const, text: "" };
        textByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "text-delta") {
        const block = textByID.get(part.id);
        if (block) block.text += part.delta;
      }
      if (part.type === "reasoning-start") {
        const block = { type: "reasoning" as const, text: "" };
        reasoningByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "reasoning-delta") {
        const block = reasoningByID.get(part.id);
        if (block) block.text += part.delta;
      }
      if (part.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
      }
      if (part.type === "error")
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }

    return {
      content,
      finishReason,
      usage,
      warnings,
      request: result.request,
      response: result.response,
    };
  }

  /**
   * One chat POST and its parsed stream. Throws for an HTTP-level failure,
   * exactly as the single-attempt version of this method did; an in-band
   * envelope failure surfaces later, as an "error" part on the stream.
   */
  private async openAttempt(
    credentials: QoderCredentials,
    options: LanguageModelV3CallOptions,
    abortController: AbortController,
    detachAbort: () => void,
  ): Promise<LanguageModelV3StreamResult> {
    const { body, warnings } = buildRequestBody(this.modelId, options, signingUserID(credentials));
    const bodyBytes = Buffer.from(JSON.stringify(body));
    const encodedBody = qoderEncodeBody(bodyBytes);
    const encodedBytes = Buffer.from(encodedBody, "utf8");
    const headers = buildAuthHeaders(encodedBytes, QODER_CHAT_URL, {
      // signingUserID(), not credentials.userID: an unresolved uid must not
      // crash the request here (cosy rejects an empty one) -- the uid's absence
      // is reported alongside a 105 instead. See signingUserID() in auth.ts.
      userID: signingUserID(credentials),
      authToken: credentials.access,
      name: credentials.name,
      email: credentials.email,
      machineID: credentials.machineID,
    });

    let response: Response;
    try {
      response = await fetch(QODER_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "User-Agent": USER_AGENT,
          "X-Model-Key": this.modelId,
          "X-Model-Source": "system",
          ...headers,
        },
        body: encodedBytes,
        signal: abortController.signal,
      });
    } catch (error) {
      detachAbort();
      throw error;
    }

    if (!response.ok) {
      detachAbort();
      const errText = await response.text().catch(() => "");
      throwQoderApiError(response.status, QODER_CHAT_URL, errText);
    }

    return {
      stream: this.responseToStream(response, warnings, detachAbort),
      request: { body },
      response: { headers: Object.fromEntries(response.headers.entries()) },
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abortController = new AbortController();
    // detachAbort exists because the listener outlives doStream(): the external
    // signal may be opencode's long-lived request signal, reused across many
    // model calls, and a listener added per call would accumulate on it. It is
    // removed however this exchange ends -- fetch failure, HTTP error, or a
    // fully consumed stream (see responseToStream's finally).
    const signal = options.abortSignal;
    const abort = () => abortController.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const detachAbort = () => signal?.removeEventListener("abort", abort);

    const resolved = await resolveQoderCredentials(this.providerOptions);
    // Two rejection shapes, two recovery sites, one policy. A rejection that
    // arrives as an HTTP status is settled here, before a stream exists (see
    // openWithHttpRetry); one that arrives inside the body can only be seen
    // while it is consumed (see replayOnAuthFailure).
    const { credentials, opened } = await this.openWithHttpRetry(
      resolved,
      options,
      abortController,
      detachAbort,
    );
    return {
      ...opened,
      stream: this.replayOnAuthFailure(
        opened.stream,
        credentials,
        options,
        abortController,
        detachAbort,
      ),
    };
  }

  /**
   * openAttempt() once, and again after renewing the credential if the gateway
   * answered with a rejection that a new credential can clear.
   *
   * Retrying at this point is always safe: nothing has been forwarded to the
   * consumer because no stream exists yet. The in-band case cannot claim that,
   * which is why its replay is gated on "no content emitted".
   */
  private async openWithHttpRetry(
    credentials: QoderCredentials,
    options: LanguageModelV3CallOptions,
    abortController: AbortController,
    detachAbort: () => void,
  ): Promise<{
    credentials: QoderCredentials;
    opened: LanguageModelV3StreamResult;
  }> {
    let current = credentials;
    for (let attempt = 0; ; attempt++) {
      try {
        return {
          credentials: current,
          opened: await this.openAttempt(current, options, abortController, detachAbort),
        };
      } catch (error) {
        if (!isQoderAuthFailure(error) || attempt > 0) {
          if (isQoderAuthFailure(error)) throw authFailureError(error, current);
          throw error;
        }
        const renewed = await refreshQoderCredentials(current).catch(() => null);
        if (!renewed) throw authFailureError(error, current);
        logPlugin("chat: HTTP credential rejection -- renewed it and retrying the request once");
        current = renewed;
      }
    }
  }

  /**
   * Forwards a chat stream, replaying the request once -- with a renewed
   * credential -- if upstream rejects it as an auth failure before any content
   * reached the consumer.
   *
   * Why the retry lives here rather than in doStream: the rejection this is
   * about does not arrive as an HTTP status. The chat endpoint answers 200 and
   * wraps the real failure in an SSE envelope
   * (`{"statusCodeValue":403,"body":"{\"code\":\"105\",\"message\":\"Login expired\"}"}`),
   * so it surfaces as an "error" part while the stream is being consumed --
   * long after doStream returned. The credential that produced it is also the
   * thing that has to change: an exchanged job token revoked server-side, or an
   * exchange whose userinfo lookup failed and left a placeholder uid to be
   * signed (Qoder reads that as "Login expired"). Both are cured by a new
   * credential, and nothing else.
   *
   * The replay is gated on "nothing forwarded yet" because a partially rendered
   * answer cannot be undone: replaying mid-stream would splice two answers into
   * one assistant message. Held-back parts are replayed verbatim when there is
   * no recovery, so the consumer still sees the original error and its finish.
   */
  private replayOnAuthFailure(
    stream: ReadableStream<LanguageModelV3StreamPart>,
    credentials: QoderCredentials,
    options: LanguageModelV3CallOptions,
    abortController: AbortController,
    detachAbort: () => void,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const model = this;
    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // Consumes `source`, forwarding parts to the consumer. Returns the parts
        // held back from an in-band auth rejection (the "error" part and
        // whatever follows it), or null when the stream ended for any other
        // reason -- including a normal finish, or a non-auth error, which are
        // forwarded untouched.
        const pump = async (
          source: ReadableStream<LanguageModelV3StreamPart>,
          mayRetry: boolean,
        ): Promise<{ held: LanguageModelV3StreamPart[]; error: unknown } | null> => {
          const reader = source.getReader();
          let held: LanguageModelV3StreamPart[] | null = null;
          let authError: unknown;
          // Anything past "stream-start" that reached the consumer cannot be
          // taken back, and a replay would append a second answer to the same
          // assistant message. Disables the retry rather than the forwarding.
          let forwarded = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value === undefined) continue;
              if (held) {
                held.push(value);
                continue;
              }
              if (
                mayRetry &&
                !forwarded &&
                value.type === "error" &&
                isQoderAuthFailure(value.error)
              ) {
                authError = value.error;
                held = [value];
                continue;
              }
              if (value.type !== "stream-start") forwarded = true;
              controller.enqueue(value);
            }
          } finally {
            if (held) await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          return held ? { held, error: authError } : null;
        };

        const finishWithError = (error: unknown): void => {
          controller.enqueue({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usageFromQoder(),
            providerMetadata: { qoder: {} },
          });
        };

        const rejected = await pump(stream, true);
        if (!rejected) {
          controller.close();
          return;
        }

        const renewed = await refreshQoderCredentials(credentials).catch(() => null);
        if (!renewed) {
          // Nothing left to try. The held parts go out verbatim unless the
          // placeholder uid is the likely culprit, in which case the envelope
          // alone would send the user hunting for an expired token.
          if (identityMissing(credentials.userID))
            finishWithError(authFailureError(rejected.error, credentials));
          else for (const part of rejected.held) controller.enqueue(part);
          controller.close();
          return;
        }

        logPlugin(
          "chat: credential rejected upstream -- renewed it and replaying the request once",
        );
        try {
          const replay = await model.openAttempt(renewed, options, abortController, detachAbort);
          // mayRetry: false -- one replay is the whole policy. A second rejection
          // means the renewed credential is not the problem, and retrying again
          // would only loop.
          const again = await pump(replay.stream, false);
          if (again) for (const part of again.held) controller.enqueue(part);
        } catch (error) {
          finishWithError(error);
        }
        controller.close();
      },
    });
  }

  private responseToStream(
    response: Response,
    warnings: SharedV3Warning[],
    detachAbort: () => void,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const modelID = this.modelId;
    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Qoder response body is empty");

        const decoder = new TextDecoder();
        const emitter = new StreamEmitter(controller);
        const tagParser = new ThinkingTagParser(emitter);
        const toolCalls: ToolCallState[] = [];
        let buffer = "";
        let rawFinishReason: string | undefined;
        let rawUsage: QoderChunk["usage"];
        let sawToolCall = false;

        const startToolCall = (state: ToolCallState): string => {
          if (!state.id) state.id = crypto.randomUUID();
          if (!state.started) {
            state.started = true;
            controller.enqueue({ type: "tool-input-start", id: state.id, toolName: state.name });
            for (const pendingDelta of state.pendingDeltas) {
              controller.enqueue({ type: "tool-input-delta", id: state.id, delta: pendingDelta });
            }
            state.pendingDeltas = [];
          }
          return state.id;
        };

        const finishToolCall = (state: ToolCallState) => {
          if (state.finished || !state.name) return;
          state.finished = true;
          const id = startToolCall(state);
          controller.enqueue({ type: "tool-input-end", id });
          controller.enqueue({
            type: "tool-call",
            toolCallId: id,
            toolName: state.name,
            input: state.arguments,
          });
          sawToolCall = true;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            while (true) {
              const lineEnd = buffer.indexOf("\n");
              if (lineEnd === -1) break;
              const line = buffer.substring(0, lineEnd).trim();
              buffer = buffer.substring(lineEnd + 1);
              if (!line) continue;

              const chunk = parseSSELine(line);
              if (!chunk) continue;

              if (chunk.id || chunk.model || chunk.created) {
                controller.enqueue({
                  type: "response-metadata",
                  id: chunk.id,
                  modelId: chunk.model || modelID,
                  timestamp: chunk.created ? new Date(chunk.created * 1000) : undefined,
                });
              }
              if (chunk.usage) rawUsage = chunk.usage;

              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) rawFinishReason = choice.finish_reason;
              const delta = choice.delta;
              if (!delta) continue;

              if (delta.reasoning_content) emitter.reasoning(delta.reasoning_content);
              if (delta.content) tagParser.process(delta.content);

              if (delta.tool_calls) {
                tagParser.finalize();
                emitter.endReasoning();
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index ?? 0;
                  let state = toolCalls[index];
                  if (!state) {
                    state = {
                      id: undefined,
                      upstreamID: false,
                      name: "",
                      arguments: "",
                      started: false,
                      finished: false,
                      pendingDeltas: [],
                    };
                    toolCalls[index] = state;
                  }
                  // Adopt the upstream id whenever it shows up. Qoder's Kimi
                  // adapter can deliver it in a later chunk than the function
                  // name, and the previous `!state.started` guard threw it away
                  // because `started` flips true as soon as the name is seen --
                  // so every Kimi tool call ended up with a fabricated UUID that
                  // the upstream could not reconcile on the next turn.
                  if (toolCallDelta.id) {
                    state.id = toolCallDelta.id;
                    state.upstreamID = true;
                  }
                  if (toolCallDelta.function?.name) state.name = toolCallDelta.function.name;
                  // Hold tool-input-start until the id is known so it is emitted
                  // with the real upstream id; buffer argument deltas meanwhile.
                  // If upstream never provides one, startToolCall() fabricates an
                  // id when the call finishes.
                  if (!state.started && state.name && state.upstreamID) startToolCall(state);
                  const argDelta = toolCallDelta.function?.arguments || "";
                  if (argDelta) {
                    state.arguments += argDelta;
                    if (state.started && state.id) {
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: state.id,
                        delta: argDelta,
                      });
                    } else {
                      state.pendingDeltas.push(argDelta);
                    }
                  }
                  if (state.started && isParsableJson(state.arguments)) finishToolCall(state);
                }
              }
            }
          }

          tagParser.finalize();
          emitter.closeOpenBlocks();
          for (const state of toolCalls) finishToolCall(state);
          controller.enqueue({
            type: "finish",
            finishReason: mapFinishReason(rawFinishReason, sawToolCall),
            usage: usageFromQoder(rawUsage),
            providerMetadata: { qoder: {} },
          });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: "error", error });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usageFromQoder(rawUsage),
            providerMetadata: { qoder: {} },
          });
          controller.close();
        } finally {
          // The exchange is over either way; drop the external signal's
          // listener before anything else so an abort racing the stream close
          // cannot re-arm the controller.
          detachAbort();
          await reader.cancel().catch(() => {});
        }
      },
    });
  }
}

export function createQoder(options: QoderProviderOptions = {}): {
  languageModel(modelID: string): LanguageModelV3;
} {
  return {
    languageModel(modelID: string) {
      return new QoderLanguageModel(modelID, options);
    },
  };
}
