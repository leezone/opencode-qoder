import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APICallError } from "@ai-sdk/provider";
import {
  identityUnresolved as identityMissing,
  type QoderCredentials,
  type QoderProviderOptions,
} from "./auth.js";
import { QODER_ERROR_CODE_LOGIN_EXPIRED, QODER_ERROR_CODE_QUOTA_EXHAUSTED } from "./constants.js";
import { opencodeConfigFile } from "./json-store.js";
import { errorMessage, logPlugin } from "./log.js";
import { listPATs, patStoreFile } from "./pat-store.js";

// ---------------------------------------------------------------------------
// Upstream error → user-friendly APICallError
// ---------------------------------------------------------------------------
// The chat endpoint wraps errors in JSON like:
//   {"code":"112","message":"{\"pricingUrl\":\"...\"}"}
// parseQoderUpstreamBody extracts the code and buildQoderErrorMessage rewrites
// the message so opencode can display it nicely (APICallError is the AI SDK
// standard). This module owns the whole "what the gateway said and how to say
// it back" surface -- HTTP failures, the in-band SSE envelope that hides a 403
// inside a 200, and the one recovery note a dead credential has to print. It is
// a leaf: the model path depends on it, nothing here depends on the model path.
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

export function parseQoderUpstreamBody(text: string): QoderUpstreamBody | undefined {
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

export function buildQoderErrorMessage(status: number, body: string): string {
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
 * How to get off a dead credential when talking is what verifies it. With one
 * account there is no way out but a new login, and the message says so. With
 * backups in the PAT store there is a second way -- qoder_pat_switch -- and a
 * third that survives the second being unavailable: a chat call is needed to
 * run a tool, and a dead credential fails every chat call, including the free
 * lite model (x0 costs no credits, not no authentication). So the store is
 * also writable from a bare shell, by path, and the running process reloads it
 * by mtime. Naming all three is the point of this note; the second one alone
 * strands a user whose only working session is the one that just errored.
 */
function patRecoveryNote(options: QoderProviderOptions): string {
  let backups: { id: string; label: string }[];
  try {
    backups = listPATs()
      .filter((entry) => !entry.active && entry.pat)
      .map((entry) => ({ id: entry.id, label: entry.label }));
  } catch {
    return "";
  }
  if (backups.length === 0) return "";
  const listed = backups
    .slice(0, 5)
    .map((entry) => `${entry.id}${entry.label ? ` ("${entry.label}")` : ""}`)
    .join(", ");
  // Name the real script when the skill is installed; otherwise point at the
  // store file, which any shell can still flip by hand. The plugin auto-registers
  // its bundled skills/ dir on v2 hosts, so the in-package copy counts too --
  // but check the config-dir copy first, since a manual copy there is what the
  // host's source dedup actually loads.
  const bundledScript = fileURLToPath(
    new URL("../skills/qoder-quota/scripts/qoder-quota.mjs", import.meta.url),
  );
  const copiedScript = opencodeConfigFile(
    join("skills", "qoder-quota", "scripts", "qoder-quota.mjs"),
  );
  const script = [copiedScript, bundledScript].find((p) => existsSync(p)) ?? "";
  const shell = script
    ? `from any shell: node ${script} --pats, then --use-pat=<id or label>`
    : `from any shell: set "active" true on one of those ids in ${patStoreFile()}`;
  const note =
    ` The PAT store has ${backups.length} inactive backup(s): ${listed}.` +
    ` Switch in-chat with qoder_pat_switch(id=...), or -- if no chat works, which is the usual case here --` +
    ` ${shell}.` +
    ` A running opencode picks that up on its next request, no restart.`;
  if (!options.apiKey && !options.personalAccessToken) return note;
  // The precedence is invisible from the outside: editing the store looks inert
  // forever when /connect or options.apiKey is what actually signs requests.
  return (
    note +
    ` Caution: this session also has a configured ${options.personalAccessToken ? "personalAccessToken" : "apiKey"},` +
    ` which outranks the PAT store -- switching stored PATs does nothing until that credential is fixed or removed.`
  );
}

/**
 * The final error for a rejection no credential renewal cleared, said as plainly
 * as possible. When the signed uid was the placeholder, that -- not the token's
 * expiry -- is the cause, and it is invisible upstream: the gateway just says
 * "Login expired". The renewal path has already been tried and failed here, so
 * the actionable step is a fresh login, and the message has to be the only place
 * the diagnosis survives.
 */
export function authFailureError(
  error: unknown,
  credentials: QoderCredentials,
  providerOptions: QoderProviderOptions = {},
): unknown {
  const note = patRecoveryNote(providerOptions);
  if (!identityMissing(credentials.userID)) {
    if (!note) return error;
    // Mutated in place: a fresh Error would drop the statusCode and response
    // body that everything downstream (and bug reports) read off an APICallError.
    if (error instanceof Error) error.message = `${error.message}${note}`;
    return error;
  }
  logPlugin("chat: auth rejection with an unresolved account uid -- a placeholder uid was signed");
  return new Error(
    `Qoder rejected this request as "Login expired" and the credential carried no ` +
      `resolvable account uid (userinfo returned nothing, so a placeholder was signed). ` +
      `Re-run /connect qoder, or check QODER_PERSONAL_ACCESS_TOKEN.` +
      note +
      ` Original error: ${errorMessage(error)}`,
  );
}

export function throwQoderApiError(status: number, url: string, body: string): never {
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
