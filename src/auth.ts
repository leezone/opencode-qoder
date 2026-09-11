import crypto from "node:crypto";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  QODER_CLIENT_TYPE,
  QODER_DEFAULT_EMAIL,
  QODER_DEFAULT_NAME,
  QODER_DEFAULT_USER_ID,
  QODER_EXCHANGE_URL,
  QODER_OPENAPI_URL,
  QODER_PAT_ENV,
  QODER_USERINFO_URL,
  QODER_VERSION,
  REFRESH_SKEW_MS,
} from "./constants.js";
import { getMachineId } from "./cosy.js";
import { jsonHeaders, readErrorBody } from "./http.js";
import { getActivePatString } from "./pat-store.js";

export interface QoderCredentials {
  access: string;
  refresh: string;
  expires: number;
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

export interface QoderProviderOptions {
  apiKey?: string;
  personalAccessToken?: string;
  qoderUserID?: string;
  qoderEmail?: string;
  qoderName?: string;
  qoderMachineID?: string;
}

// Response shape shared by the token exchange, the device-token poll, and (if
// it were ever wired up) a refresh call: all answer with a job token plus its
// expiry. Declared once; it used to be retyped inline at each call site.
export interface QoderTokenResponse {
  token?: string;
  user_id?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
}

export const PAT_REFRESH_PREFIX = "pat";

const credentialsCache = new Map<string, Promise<QoderCredentials> | QoderCredentials>();

export function encodePatRefresh(
  pat: string,
  jobRefreshToken: string,
  userID: string,
  machineID: string,
): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

export function encodeOAuthRefresh(
  refreshToken: string,
  userID: string,
  machineID: string,
): string {
  return [refreshToken, userID, machineID].join("|");
}

export function decodeOAuthRefresh(refresh: string): {
  refreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    refreshToken: parts[0] || "",
    userID: parts[1] || "",
    machineID: parts[2] || "",
  };
}

function getEnvPat(): string {
  for (const key of QODER_PAT_ENV) {
    const value = process.env[key];
    if (value) return value;
  }
  return "";
}

function parseExpiresAt(expiresAt?: string, expiresIn?: number): number {
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number.parseInt(expiresAt, 10);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  if (expiresIn && expiresIn > 0) {
    // The exchange endpoint answers in milliseconds; a seconds-scaled value
    // only ever shows up here if upstream changes units or a caller passes one
    // in, hence the >7-days heuristic. The device-flow login does NOT use this
    // helper: it always answers in seconds (30-day default), and 2.59e6 is
    // above the 7-day threshold, so routing it through here would read it as
    // milliseconds and expire the token in ~43 minutes. It keeps its own
    // parser in index.ts for exactly that reason.
    return Date.now() + (expiresIn > 7 * 24 * 60 * 60 ? expiresIn : expiresIn * 1000);
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

// Fallback identity for the profile fields, applied wherever a QoderCredentials
// is synthesized from a possibly-partial upstream profile. credentialsFromPat(),
// resolveQoderCredentials() and the device-flow login all needed the same triple;
// it was the copy-paste point, so it is the place a rename used to drift.
export function withProfileDefaults(profile: { userID?: string; email?: string; name?: string }): {
  userID: string;
  email: string;
  name: string;
} {
  return {
    userID: profile.userID || QODER_DEFAULT_USER_ID,
    email: profile.email || QODER_DEFAULT_EMAIL,
    name: profile.name || QODER_DEFAULT_NAME,
  };
}

// The openapi.qoder.sh identity endpoints expect these two client tags on the
// JSON calls that carry no COSY signature.
function openApiHeaders(token?: string): Record<string, string> {
  return jsonHeaders({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Cosy-Version": QODER_VERSION,
    "Cosy-ClientType": QODER_CLIENT_TYPE,
  });
}

// Best-effort identity lookup. Both credential paths (PAT exchange and the
// device-flow login) call it; a failure yields an empty profile rather than a
// throw, since the token is already valid without it.
export async function fetchQoderUserInfo(
  jobToken: string,
): Promise<{ userID: string; email: string; name: string }> {
  const info = await fetchQoderAccount(jobToken);
  return {
    userID: text(info.id),
    email: text(info.email),
    name: text(info.name) || text(info.username),
  };
}

// The whole account record, undifferentiated. fetchQoderUserInfo() projects the
// three fields the plugin itself needs; the tool surface wants organisation,
// plan source and avatar too, and re-listing every field upstream adds would
// only recreate the camelCase drift this module already fights. Best-effort:
// an unreachable endpoint answers {} rather than throwing.
export async function fetchQoderAccount(jobToken: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(QODER_USERINFO_URL, { headers: openApiHeaders(jobToken) });
    if (!res.ok) return {};
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Describes a credential without ever printing it. A log file is no place for a
// PAT, but the shape is exactly what tells an unresolved `{file:...}` reference
// apart from a real token, or from the option not reaching the plugin at all.
// Shared with capabilities.ts, which reports the credential *layer* to a model
// under the same rule: shape only, never the value.
export function describeTokenShape(value: unknown): string {
  if (typeof value !== "string" || value === "") return "absent";
  if (value.startsWith("{file:")) return "file-ref";
  if (value.startsWith("{env:")) return "env-ref";
  if (value.startsWith("pt-")) return "pat";
  return `opaque(${value.length})`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function credentialsFromPat(pat: string): Promise<QoderCredentials> {
  const cached = credentialsCache.get(pat);
  if (cached) {
    const resolved = await cached;
    if (resolved.expires > Date.now()) return resolved;
    credentialsCache.delete(pat);
  }

  const pending = (async () => {
    const res = await fetch(QODER_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...openApiHeaders() },
      body: JSON.stringify({ personal_token: pat }),
    });

    if (!res.ok) {
      throw new Error(
        `Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${await readErrorBody(res)}`,
      );
    }

    const data = (await res.json()) as QoderTokenResponse;
    if (!data.token) throw new Error("Qoder PAT exchange returned no job token");

    // encodePatRefresh stores the RAW upstream userID (empty when userinfo was
    // unreachable), while the returned credential carries the defaulted one --
    // so keep the raw profile separate from the applied-defaults one.
    const rawProfile = await fetchQoderUserInfo(data.token);
    const profile = withProfileDefaults(rawProfile);
    const machineID = getMachineId();
    return {
      refresh: encodePatRefresh(pat, data.refresh_token || "", rawProfile.userID, machineID),
      access: data.token,
      expires: parseExpiresAt(data.expires_at, data.expires_in) - REFRESH_SKEW_MS,
      ...profile,
      machineID,
    } satisfies QoderCredentials;
  })();

  credentialsCache.set(pat, pending);
  try {
    const resolved = await pending;
    credentialsCache.set(pat, resolved);
    return resolved;
  } catch (error) {
    credentialsCache.delete(pat);
    throw error;
  }
}

// The credential funnel: every code path that talks to Qoder ends here, which
// makes this the right place to write down the token precedence it applies.
// Layers 1-3 are assembled by the callers (index.ts builds the options bag;
// see discoveryOptions() there); layers 4-6 are applied below.
//
// Token precedence, highest first:
//   1. personalAccessToken option -- explicit, rarely set, but wins over
//      everything when present (checked first below);
//   2. connection credential -- what `/connect qoder` stored (a PAT or an
//      oauth access token), resolved by authOptionsFromV2Connection() or the
//      legacy auth loader;
//   3. plugin options apiKey -- ctx.options / the provider options in
//      opencode.json, already substituted from `{file:...}` by the time the
//      legacy config hook runs;
//   4. shared apiKey -- the token the legacy config hook published over
//      globalThis for the v2 instance, which cannot see (2)/(3) itself;
//   5. active PAT from pat-store -- the currently selected multi-account entry
//      from ~/.config/opencode/qoder-pats.json (getActivePatString);
//   6. environment -- QODER_PERSONAL_ACCESS_TOKEN, then QODER_PAT (getEnvPat).
//
// Once a token is in hand the shape decides the path: a `pt-` prefix routes to
// credentialsFromPat() (exchange endpoint, memoized per PAT), and anything
// else is treated as an already-exchanged short-lived job token and passed
// through as-is -- which is also how the device-flow oauth credential arrives.
export async function resolveQoderCredentials(
  options: QoderProviderOptions = {},
): Promise<QoderCredentials> {
  const token = options.personalAccessToken || options.apiKey || getActivePatString() || getEnvPat();
  if (!token) {
    throw new Error(
      "Qoder credentials not set. Run `/connect qoder` in opencode or set QODER_PERSONAL_ACCESS_TOKEN.",
    );
  }

  if (token.startsWith("pt-")) return credentialsFromPat(token);

  return {
    access: token,
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    ...withProfileDefaults({
      userID: options.qoderUserID,
      email: options.qoderEmail,
      name: options.qoderName,
    }),
    machineID: options.qoderMachineID || getMachineId(),
  };
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// Plain sleep. It was called abortableDelay but never accepted a signal or
// abort reason -- the device poll loop just awaits it between attempts. Named
// for what it does.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Device-flow login, second half: poll for the token the browser session
// authorizes. The first half (PKCE + authorize URL) lives with the caller --
// opencode's auth hook opens the browser and invokes pollDeviceFlow afterwards.
// Lives in auth.ts rather than index.ts because every other credential
// acquisition path does, and it shares this module's primitives: the token
// response shape, userinfo lookup, refresh encoding, and profile defaults.
export async function pollDeviceFlow(
  codeVerifier: string,
  nonce: string,
  machineID: string,
): Promise<QoderCredentials> {
  const pollURL = `${QODER_OPENAPI_URL}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

  for (let attempt = 0; attempt < 90; attempt++) {
    await delay(2000);
    const response = await fetch(pollURL, { method: "GET", headers: jsonHeaders() });
    if (response.status === 202 || response.status === 404) continue;
    if (!response.ok) {
      throw new Error(
        `Device token poll failed: ${response.status} ${response.statusText}. Response: ${await readErrorBody(response)}`,
      );
    }

    const tokenData = (await response.json()) as QoderTokenResponse;
    if (!tokenData.token) throw new Error("Device token poll returned empty access token");

    // Shared with the PAT exchange path. Adds two Cosy-* headers the old
    // inline call omitted; userinfo is a plain Bearer GET that ignores them.
    const profile = await fetchQoderUserInfo(tokenData.token);

    // The device flow answers expires_in in SECONDS (see DEVICE_TOKEN_TTL_SECONDS
    // in constants.ts). It cannot reuse parseExpiresAt above, whose >7-days
    // heuristic would read 30 days as milliseconds and expire the token in ~43
    // minutes.
    const parsedExpires = tokenData.expires_at ? Date.parse(tokenData.expires_at) : Number.NaN;
    const expires = Number.isFinite(parsedExpires)
      ? parsedExpires
      : Date.now() + (tokenData.expires_in || DEVICE_TOKEN_TTL_SECONDS) * 1000;

    // encodeOAuthRefresh keeps the raw user_id (may be empty), matching the PAT
    // exchange; only the credential's identity fields get defaults applied.
    return {
      refresh: encodeOAuthRefresh(
        tokenData.refresh_token || "",
        tokenData.user_id || "",
        machineID,
      ),
      access: tokenData.token,
      expires: expires - REFRESH_SKEW_MS,
      ...withProfileDefaults({
        userID: tokenData.user_id,
        email: profile.email,
        name: profile.name,
      }),
      machineID,
    };
  }

  throw new Error("Authorization timed out");
}
