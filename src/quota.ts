import { type QoderProviderOptions, resolveQoderCredentials } from "./auth.js";
import { FETCH_TIMEOUT_MS, QODER_QUOTA_URL } from "./constants.js";
import { fetchWithTimeout, jsonHeaders } from "./http.js";
import { errorMessage, logPlugin } from "./log.js";

// --- Credit quota -----------------------------------------------------------
//
// qodercli: getQuotaUsage() + OsA()/R7(). Plain Bearer auth -- unlike the model
// list, this endpoint needs no COSY signing.
//
// Split out of model-catalog.ts because it is an independent concern: its own
// endpoint, its own protocol, and its own module state. model-catalog.ts reads
// the state through getQuotaExhausted() when rendering names and signing the
// catalog, and stamps it via setQuotaExhausted() on the refresh cadence.

let quotaExhausted = false;

export function getQuotaExhausted(): boolean {
  return quotaExhausted;
}

export function setQuotaExhausted(value: boolean): void {
  quotaExhausted = value;
}

// The buckets the account can draw on, labelled for the log. Single source for
// isQuotaExhausted()'s sum AND quotaSnapshot()'s rendering: the camelCase /
// snake_case key lists used to be retyped in both, and a rename upstream would
// have had to land in two places.
const QUOTA_BUCKETS: ReadonlyArray<readonly [label: string, keys: readonly string[]]> = [
  ["userQuota", ["user_quota", "userQuota"]],
  ["addOnQuota", ["add_on_quota", "addOnQuota"]],
  ["orgPackage", ["org_resource_package", "orgResourcePackage", "shared_quota", "sharedQuota"]],
];

function bucketRemaining(usage: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const bucket = usage[key];
    if (bucket && typeof bucket === "object") {
      const remaining = Number((bucket as Record<string, unknown>).remaining);
      if (Number.isFinite(remaining)) return remaining;
    }
  }
  return 0;
}

function totalRemaining(usage: Record<string, unknown>): number {
  return QUOTA_BUCKETS.reduce((sum, [, keys]) => sum + bucketRemaining(usage, keys), 0);
}

// Explicit exceeded flag, or undefined when the payload carries neither spelling.
function quotaFlag(usage: Record<string, unknown>): boolean | undefined {
  const flag = usage.is_quota_exceeded ?? usage.isQuotaExceeded;
  return typeof flag === "boolean" ? flag : undefined;
}

// qodercli: OsA(usage) -- the exceeded flag, or every bucket drained.
export function isQuotaExhausted(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const usage = payload as Record<string, unknown>;
  // normalizeQuotaUsage() rejects a response without user_id AND user_type.
  // Skipping this guard would read a malformed or empty payload as "0
  // remaining" and mark every paid model unavailable.
  const userID = usage.user_id ?? usage.userId;
  const userType = usage.user_type ?? usage.userType;
  if (typeof userID !== "string" || userID === "" || typeof userType !== "string" || !userType) {
    return false;
  }
  const flag = quotaFlag(usage);
  const remaining = totalRemaining(usage);
  // total_usage_percentage is deliberately NOT consulted, though qodercli falls
  // back to it. The live endpoint returns it as a fraction (1 == 100%), and it
  // measures the plan quota alone: observed with userQuota at 3000/3000 while
  // orgResourcePackage still held 229 and isQuotaExceeded was false. Reading it
  // as ">= 100" would be wrong twice over -- wrong scale, and it would call an
  // account exhausted that still has an org package to draw on.
  if (flag !== undefined) return flag || remaining <= 0;
  return remaining <= 0;
}

// Renders why isQuotaExhausted() decided what it did. Without this, a log of
// "exhausted=false" cannot be told apart from "the quota call failed open" --
// and both leave every paid model looking usable.
function quotaSnapshot(usage: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [label, keys] of QUOTA_BUCKETS) {
    const bucket = keys
      .map((key) => usage[key])
      .find((value): value is Record<string, unknown> => !!value && typeof value === "object");
    if (!bucket) continue;
    const left = Number(bucket.remaining);
    if (!Number.isFinite(left)) {
      parts.push(`${label}=?`);
      continue;
    }
    // The live payload spells the org package's ceiling `cap`, not `total`.
    const cap = Number(bucket.total ?? bucket.cap);
    parts.push(Number.isFinite(cap) ? `${label}=${left}/${cap}` : `${label}=${left}`);
  }
  if (parts.length === 0) parts.push("buckets=<none>");
  parts.push(`flag=${quotaFlag(usage) ?? "absent"}`);
  const pct = Number(usage.total_usage_percentage ?? usage.totalUsagePercentage);
  // Shown as a percentage for readability. It is a fraction upstream and is
  // deliberately not part of the decision -- see isQuotaExhausted().
  if (Number.isFinite(pct)) parts.push(`planUsage=${(pct * 100).toFixed(1)}%`);
  return parts.join(" ");
}

// Fails open: an unreachable quota endpoint must not paint the whole catalog
// unavailable. qodercli's vEu() returns false on error too.
export async function fetchQuotaExhausted(options: QoderProviderOptions): Promise<boolean> {
  try {
    const credentials = await resolveQoderCredentials(options);
    return await fetchWithTimeout(
      QODER_QUOTA_URL,
      { headers: jsonHeaders({ Authorization: `Bearer ${credentials.access}` }) },
      FETCH_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) {
          logPlugin(`quota: HTTP ${response.status} -- failing open, nothing marked Unavailable`);
          return false;
        }
        const payload: unknown = await response.json();
        const exhausted = isQuotaExhausted(payload);
        const usage =
          payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        logPlugin(`quota: exhausted=${exhausted} ${quotaSnapshot(usage)}`);
        return exhausted;
      },
    );
  } catch (error) {
    logPlugin(`quota: ${errorMessage(error)} -- failing open, nothing marked Unavailable`);
    return false;
  }
}
