import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { text } from "./coerce.js";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  QODER_CLIENT_TYPE,
  QODER_DEFAULT_EMAIL,
  QODER_DEFAULT_NAME,
  QODER_DEFAULT_USER_ID,
  QODER_PAT_ENV,
  QODER_VERSION,
  type QoderRegion,
  REFRESH_SKEW_MS,
  resolveEndpoints,
} from "./constants.js";
import { type CosyCredentials, getMachineId } from "./cosy.js";
import { jsonHeaders, readErrorBody } from "./http.js";
import { opencodeDataFile } from "./json-store.js";
import { keyFileToken } from "./key-file.js";
import { errorMessage, logPlugin } from "./log.js";
import { isImportListValue } from "./pat-import.js";
import { getActivePatString, getSelectedPatString } from "./pat-store.js";

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
  // The pipe-encoded refresh field opencode stores for a device-flow (Browser
  // Login) credential: `refreshToken|userID|machineID`. Only consumed by the
  // refresh path; PAT credentials carry their own encoding.
  refreshToken?: string;
  qoderUserID?: string;
  qoderEmail?: string;
  qoderName?: string;
  qoderMachineID?: string;
  // Which Qoder deployment this instance serves. Carried on the options bag
  // because the same process hosts both providers and module state would
  // collide. Defaults to "global" wherever it is absent, so a single-region
  // config and every existing call site keep working unchanged.
  region?: QoderRegion;
}

// Reads the region off an options bag, defaulting to the international site.
export function regionOf(options?: QoderProviderOptions): QoderRegion {
  return options?.region ?? "global";
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

// A credential whose uid never got resolved. The placeholder must stay a
// DISPLAY fallback: the gateway answers "Login expired" (code 105) to a COSY
// payload signed with a fake uid, so a signing path that sees this value must
// resolve the identity first rather than send it. Anything that smells like the
// placeholder counts as unresolved, including a value that an earlier version
// persisted into a connection's metadata.
export function identityUnresolved(userID: string | undefined): boolean {
  return !userID || userID === QODER_DEFAULT_USER_ID;
}

type QoderIdentity = { userID: string; email: string; name: string };

// Identity lookups memoize per job token. A conversation that had to resolve
// its uid once must not re-hit userinfo on every following turn, and a dead
// token fails resolution forever -- so a miss is memoized too, with a cooldown
// rather than a final verdict, because the same PAT can be re-exchanged into a
// token that resolves. Bounded: entries die with their token anyway.
const identityByToken = new Map<string, { attemptedAt: number; identity: QoderIdentity | null }>();
const IDENTITY_RETRY_COOLDOWN_MS = 30 * 1000;
const IDENTITY_CACHE_MAX = 64;

function identityKey(jobToken: string, region: QoderRegion): string {
  return `${region}\0${jobToken}`;
}

function rememberIdentity(
  jobToken: string,
  identity: QoderIdentity | null,
  region: QoderRegion = "global",
  attemptedAt = Date.now(),
): void {
  jobToken = identityKey(jobToken, region);
  if (identityByToken.size >= IDENTITY_CACHE_MAX && !identityByToken.has(jobToken)) {
    // Oldest-first eviction; Map iteration order is insertion order.
    const oldest = identityByToken.keys().next().value;
    if (oldest !== undefined) identityByToken.delete(oldest);
  }
  identityByToken.set(jobToken, { attemptedAt, identity });
}

// The identity a signed request needs, or null when it cannot be had. Unlike
// fetchQoderUserInfo() this distinguishes "the lookup worked" from "the account
// record carries an id", because an empty id is exactly the state that produces
// a 105 and must be retried rather than papered over with a default.
export async function fetchQoderIdentity(
  jobToken: string,
  region: QoderRegion = "global",
): Promise<QoderIdentity | null> {
  const key = identityKey(jobToken, region);
  const memo = identityByToken.get(key);
  if (memo) {
    if (memo.identity) return memo.identity;
    if (Date.now() - memo.attemptedAt < IDENTITY_RETRY_COOLDOWN_MS) return null;
  }

  const info = await fetchQoderAccount(jobToken, region);
  const userID = text(info.id);
  if (!userID) {
    rememberIdentity(jobToken, null, region);
    return null;
  }
  const identity: QoderIdentity = {
    userID,
    email: text(info.email),
    name: text(info.name) || text(info.username),
  };
  rememberIdentity(jobToken, identity, region);
  return identity;
}

// Fills in a credential's identity when it is missing, leaving the argument
// untouched (and the request free to fail loudly) when it cannot be resolved.
// Every path that signs a request calls this, so the uid that reaches COSY is
// either the account's real one or the caller is told why there is none.
export async function ensureQoderIdentity(
  creds: QoderCredentials,
  region: QoderRegion = "global",
): Promise<QoderCredentials> {
  if (!identityUnresolved(creds.userID)) return creds;
  const identity = await fetchQoderIdentity(creds.access, region);
  if (!identity) return creds;
  return {
    ...creds,
    userID: identity.userID,
    email: creds.email || identity.email,
    name: creds.name || identity.name,
  };
}

// The uid to put into a signed COSY payload.
//
// Upstream is asymmetric about this value, and the asymmetry is why a request
// cannot simply refuse to sign when the identity is unresolved: the model-list
// endpoint accepts a placeholder uid (catalog discovery keeps working), while
// the chat endpoint rejects it with "Login expired" (105). Hard-failing on an
// unresolved uid would therefore break a working model list over a userinfo
// outage, which is a worse trade than the status quo.
//
// So this returns the real uid when ensureQoderIdentity() got one and the
// placeholder otherwise -- and callers that can do something better with the
// distinction check identityUnresolved() themselves, which is exactly what the
// chat path does to turn a 105 into a diagnosis instead of a raw error blob.
export function signingUserID(creds: QoderCredentials): string {
  return identityUnresolved(creds.userID) ? QODER_DEFAULT_USER_ID : creds.userID;
}

// opencode's auth.json entry for a provider, as read off disk. The tool
// fallback in capabilities.ts and the auth() hook in index.ts both parse this
// shape; `refresh` carries the pipe-encoded form above.
export interface StoredCredential {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}

// QoderCredentials -> CosyCredentials, the projection both signing call sites
// used to hand-copy: the lenient catalog fetch and the chat request. Kept here
// so signingUserID() cannot be missed by a future call site (a raw creds.userID
// would sign the placeholder uid and buy a 105).
export function cosyCredentialsForSigning(creds: QoderCredentials): CosyCredentials {
  return {
    userID: signingUserID(creds),
    authToken: creds.access,
    name: creds.name,
    email: creds.email,
    machineID: creds.machineID,
  };
}

// The auth-failure escape hatch. Without it a credential that the gateway has
// already rejected -- a revoked job token, or an exchange whose userinfo lookup
// failed and froze a placeholder identity for the whole TTL -- keeps being
// served from the per-PAT cache until its local clock lapses, up to ~24h of
// "Login expired" for a token that a single re-exchange would replace.
// Keyed by PAT (the exchange cache's key); a passthrough token has no cache
// entry to drop and simply gets re-resolved by the caller.
export function invalidateQoderCredentials(pat: string, region: QoderRegion = "global"): void {
  // Read before deleting: the identity memo is keyed by access token, and once
  // the credential entry is gone that mapping is unrecoverable.
  const cacheKey = `${region}\0${pat}`;
  const cached = credentialsCache.get(cacheKey);
  credentialsCache.delete(cacheKey);
  // The next call exchanges for a new job token, so a "cannot resolve" verdict
  // recorded against the old one must not survive to shadow it.
  if (cached && !(cached instanceof Promise))
    identityByToken.delete(identityKey(cached.access, region));
}

// Exported for quota-cli.ts: the standalone credential walk must end on this
// same layer (last), exactly as the table above resolveQoderCredentials() says.
export function getEnvPat(): string {
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

// Fallback identity for the DISPLAY fields, applied wherever a QoderCredentials
// is synthesized from a possibly-partial upstream profile. credentialsFromPat(),
// resolveQoderCredentials() and the device-flow login all needed the same pair;
// it was the copy-paste point, so it is the place a rename used to drift.
//
// userID deliberately gets NO default here. It is the field the COSY signature
// carries as `uid`, and the gateway rejects a placeholder uid with "Login
// expired" (105) -- so an unresolved uid must stay visibly unresolved and be
// settled by ensureQoderIdentity(), not silently replaced with a value that
// then gets signed and memoized for the life of the token.
export function withProfileDefaults(profile: { userID?: string; email?: string; name?: string }): {
  userID: string;
  email: string;
  name: string;
} {
  return {
    userID: profile.userID || "",
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
  region: QoderRegion = "global",
): Promise<{ userID: string; email: string; name: string }> {
  const info = await fetchQoderAccount(jobToken, region);
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
export async function fetchQoderAccount(
  jobToken: string,
  region: QoderRegion = "global",
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(resolveEndpoints(region).userinfo, {
      headers: openApiHeaders(jobToken),
    });
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

export async function credentialsFromPat(
  pat: string,
  region: QoderRegion = "global",
): Promise<QoderCredentials> {
  // Cache key includes the region: the same PAT string is exchanged against a
  // different host per region, and the resulting job token is only valid there.
  const cacheKey = `${region}\0${pat}`;
  const cached = credentialsCache.get(cacheKey);
  if (cached) {
    const resolved = await cached;
    if (resolved.expires > Date.now()) return resolved;
    credentialsCache.delete(cacheKey);
  }

  const pending = (async () => {
    const res = await fetch(resolveEndpoints(region).exchange, {
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
    //
    // fetchQoderIdentity() rather than fetchQoderUserInfo(): it is the memoized
    // lookup, so resolveQoderCredentials()'s ensureQoderIdentity() answers from
    // it instead of fetching userinfo a second time for the same token. Same
    // endpoint and fields; a null (no usable id) is the same "" uid, only
    // remembered.
    const identity = await fetchQoderIdentity(data.token, region);
    const rawProfile = {
      userID: identity?.userID ?? "",
      email: identity?.email ?? "",
      name: identity?.name ?? "",
    };
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

  credentialsCache.set(cacheKey, pending);
  try {
    const resolved = await pending;
    credentialsCache.set(cacheKey, resolved);
    return resolved;
  } catch (error) {
    credentialsCache.delete(cacheKey);
    throw error;
  }
}

// What `/connect qoder` persisted, read off opencode's own store. The plugin
// normally never needs this read -- opencode hands the connection credential to
// it directly (layer 3 above). The disk form exists for the surfaces opencode
// does not feed: the capability tools in the legacy realm, and the standalone
// CLI, which has no realm at all. Best-effort and read-only: a missing file, a
// different install layout or corrupt JSON all collapse to "", so a report says
// the credential is absent rather than guessing.
export function storedConnectionToken(): string {
  try {
    const parsed = JSON.parse(readFileSync(opencodeDataFile("auth.json"), "utf8")) as {
      qoder?: StoredCredential;
    };
    const entry = parsed.qoder;
    if (!entry) return "";
    return text(entry.key) || text(entry.access);
  } catch {
    return "";
  }
}

// The credential funnel: every code path that talks to Qoder ends here, which
// makes this the right place to write down the token precedence it applies.
// Layers 1-4 are assembled by the callers (index.ts builds the options bag;
// see discoveryOptions() there); layers 5-8 are applied below.
//
// Token precedence, highest first:
//   1. personalAccessToken option -- explicit, rarely set, but wins over
//      everything when present (checked first below);
//   2. explicit store selection -- the entry the user last passed to
//      qoder_pat_switch (getSelectedPatString). A deliberate act outranks
//      passive configuration; the auto-activated first import does NOT count;
//   3. connection credential -- what `/connect qoder` stored (a PAT or an
//      oauth access token), resolved by authOptionsFromV2Connection() or the
//      legacy auth loader;
//   4. plugin options apiKey -- ctx.options / the provider options in
//      opencode.json, already substituted from `{file:...}` by the time the
//      legacy config hook runs. An apiKey that parses as a PAT LIST (a config
//      pointing at a multi-token seed file) is importer input, not a bearer
//      token, and is skipped here;
//   5. shared apiKey -- the token the legacy config hook published over
//      globalThis for the v2 instance, which cannot see (3)/(4) itself;
//   6. key file, single form -- the token inside ~/.qoderkey_env (or the
//      configured keyFile path) when it holds exactly one credential
//      (keyFileToken); the plugin-owned replacement for option (4), so the
//      file's location never has to appear in config. A LIST in that file is
//      consumed by the importer instead and contributes no token here;
//   7. active PAT from pat-store -- the currently selected multi-account
//      entry from ~/.config/opencode/qoder-pats.json (getActivePatString);
//   8. environment -- QODER_PERSONAL_ACCESS_TOKEN, then QODER_PAT (getEnvPat).
//
// Once a token is in hand the shape decides the path: a `pt-` prefix routes to
// credentialsFromPat() (exchange endpoint, memoized per PAT), and anything
// else is treated as an already-exchanged short-lived job token and passed
// through as-is -- which is also how the device-flow oauth credential arrives.
//
// Both branches then settle the identity. This is the funnel every Qoder call
// walks through, so it is the one place that can guarantee a signed request
// carries a real uid rather than the placeholder that gets chat rejected with
// 105 -- see ensureQoderIdentity(), which memoizes per token and therefore
// costs a userinfo round trip at most once per credential.
export async function resolveQoderCredentials(
  options: QoderProviderOptions = {},
): Promise<QoderCredentials> {
  const region = regionOf(options);
  const apiKey = options.apiKey && !isImportListValue(options.apiKey) ? options.apiKey : "";
  // The store layers are region-scoped: a CN instance must not sign with an
  // international PAT (or vice versa), which is exactly what an unscoped read
  // would do when both providers are configured.
  const token =
    options.personalAccessToken ||
    getSelectedPatString(region) ||
    apiKey ||
    // The key file is a USER-designated seed (an explicit path they configure),
    // not plugin-managed state, so it is shared across regions on purpose: it
    // is the same kind of input as an environment variable, and pointing both
    // providers at one secret file is the reasonable default. The stores below
    // are plugin-managed and therefore region-scoped.
    keyFileToken() ||
    getActivePatString(region) ||
    getEnvPat();
  if (!token) {
    throw new Error(
      "Qoder credentials not set. Run `/connect qoder` in opencode or set QODER_PERSONAL_ACCESS_TOKEN.",
    );
  }

  if (token.startsWith("pt-"))
    return ensureQoderIdentity(await credentialsFromPat(token, region), region);

  return ensureQoderIdentity({
    access: token,
    refresh: options.refreshToken || "",
    expires: Date.now() + 60 * 60 * 1000,
    ...withProfileDefaults({
      // A stored connection may still carry the old display placeholder as its
      // uid (an earlier version persisted it). Treat it as unresolved so
      // ensureQoderIdentity() settles it instead of signing a fake uid.
      userID: identityUnresolved(options.qoderUserID) ? "" : options.qoderUserID,
      email: options.qoderEmail,
      name: options.qoderName,
    }),
    machineID: options.qoderMachineID || getMachineId(region),
  });
}

// PAT-encoded refresh field? credentialsFromPat() writes `pat|<pat>|...` so a
// stored credential can be told apart from a raw device-flow refresh token.
export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_REFRESH_PREFIX}|`);
}

export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

// Replace a rejected credential. The one recovery both failure modes share --
// a job token revoked server-side before its stated expiry, and an exchange
// whose userinfo lookup failed -- is "get a new credential", and which lever
// that depends on the shape of the stored refresh field:
//
//   * PAT-encoded (`pat|<pat>|...`): re-run the exchange. The PAT is long-lived,
//     so this is the whole story; invalidate first so credentialsFromPat() does
//     not hand back the same poisoned entry.
//   * device-flow refresh token: POST it to the refresh endpoint and read a new
//     job token out of the response. Reference: pi-provider-qoder's
//     refreshQoderTokenForMode(), which is wired into pi core as the provider's
//     refreshToken callback -- opencode's plugin API has no such hook, so this
//     is called from the request path instead.
//
// Returns null when there is nothing to refresh from (a bare passthrough token
// with no refresh field) or the refresh itself failed -- callers surface that
// as "re-run /connect", never as another silent retry with the dead credential.
export async function refreshQoderCredentials(
  creds: QoderCredentials,
  region: QoderRegion = "global",
): Promise<QoderCredentials | null> {
  if (isPatRefresh(creds.refresh)) {
    const { pat } = decodePatRefresh(creds.refresh);
    if (!pat) return null;
    invalidateQoderCredentials(pat, region);
    try {
      const refreshed = await credentialsFromPat(pat, region);
      return identityUnresolved(refreshed.userID)
        ? await ensureQoderIdentity(refreshed, region)
        : refreshed;
    } catch (error) {
      logRefreshFailure("PAT re-exchange", error);
      return null;
    }
  }

  const { refreshToken, userID, machineID } = decodeOAuthRefresh(creds.refresh);
  if (!refreshToken) return null;

  try {
    const res = await fetch(resolveEndpoints(region).refresh, {
      method: "POST",
      headers: openApiHeaders(creds.access),
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      logRefreshFailure("refresh endpoint", new Error(`${res.status} ${res.statusText}`));
      return null;
    }
    const data = (await res.json()) as QoderTokenResponse;
    if (!data.token) return null;

    const parsedExpires = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const expires = Number.isFinite(parsedExpires)
      ? parsedExpires
      : Date.now() + (data.expires_in || DEVICE_TOKEN_TTL_SECONDS) * 1000;

    const refreshed: QoderCredentials = {
      access: data.token,
      // Upstream may rotate the refresh token; keep the old one if it does not.
      refresh: encodeOAuthRefresh(data.refresh_token || refreshToken, userID, machineID),
      expires: expires - REFRESH_SKEW_MS,
      userID,
      email: creds.email,
      name: creds.name,
      machineID: machineID || creds.machineID,
    };
    return identityUnresolved(refreshed.userID) ? await ensureQoderIdentity(refreshed) : refreshed;
  } catch (error) {
    logRefreshFailure("refresh endpoint", error);
    return null;
  }
}

// A failed refresh is normally the end of the plugin's recovery options, and
// the reason it failed is the one thing the user needs to act on. Logged rather
// than thrown so the caller can still surface its "re-run /connect" verdict
// without the cause being lost.
function logRefreshFailure(where: string, error: unknown): void {
  logPlugin(`auth: refresh failed via ${where} (${errorMessage(error)})`);
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
  region: QoderRegion = "global",
): Promise<QoderCredentials> {
  const pollURL = `${resolveEndpoints(region).devicePoll}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

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
