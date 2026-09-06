import crypto from "node:crypto";
import {
  QODER_CLIENT_TYPE,
  QODER_DEFAULT_EMAIL,
  QODER_DEFAULT_NAME,
  QODER_DEFAULT_USER_ID,
  QODER_EXCHANGE_URL,
  QODER_PAT_ENV,
  QODER_USERINFO_URL,
  QODER_VERSION,
  REFRESH_SKEW_MS,
} from "./constants.js";
import { getMachineId } from "./cosy.js";
import { jsonHeaders, readErrorBody } from "./http.js";

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
  try {
    const res = await fetch(QODER_USERINFO_URL, { headers: openApiHeaders(jobToken) });
    if (!res.ok) return { userID: "", email: "", name: "" };
    const info = (await res.json()) as {
      id?: string;
      email?: string;
      name?: string;
      username?: string;
    };
    return {
      userID: info.id || "",
      email: info.email || "",
      name: info.name || info.username || "",
    };
  } catch {
    return { userID: "", email: "", name: "" };
  }
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

export async function resolveQoderCredentials(
  options: QoderProviderOptions = {},
): Promise<QoderCredentials> {
  const token = options.personalAccessToken || options.apiKey || getEnvPat();
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
