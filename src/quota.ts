import { type QoderProviderOptions, resolveQoderCredentials } from "./auth.js";
import { text } from "./coerce.js";
import { FETCH_TIMEOUT_MS, QODER_QUOTA_URL } from "./constants.js";
import { fetchWithTimeout, jsonHeaders, readErrorBody } from "./http.js";
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
//
// Two layers, deliberately separate:
//   fetchQuotaUsage()    -- throws. For callers that must report WHY (tools).
//   fetchQuotaExhausted() -- fails open. For discovery, where an unreachable
//                          quota endpoint must not paint the catalog unavailable.

let quotaExhausted = false;

export function getQuotaExhausted(): boolean {
  return quotaExhausted;
}

export function setQuotaExhausted(value: boolean): void {
  quotaExhausted = value;
}

// Stable identifiers for the buckets the account can draw on. `key` is what logs
// and tool output identify a bucket by; `label` is the human spelling.
//
// Single source for isQuotaExhausted()'s sum AND quotaSnapshot()'s rendering AND
// the tool report: the camelCase / snake_case key lists used to be retyped in
// both, and a rename upstream would have had to land in two places.
export type QuotaBucketKey = "userQuota" | "addOnQuota" | "orgPackage";

const QUOTA_BUCKETS: ReadonlyArray<{
  key: QuotaBucketKey;
  label: string;
  keys: readonly string[];
}> = [
  { key: "userQuota", label: "plan", keys: ["user_quota", "userQuota"] },
  { key: "addOnQuota", label: "add-on", keys: ["add_on_quota", "addOnQuota"] },
  {
    key: "orgPackage",
    label: "org package",
    keys: ["org_resource_package", "orgResourcePackage", "shared_quota", "sharedQuota"],
  },
];

export type QuotaBucket = {
  key: QuotaBucketKey;
  label: string;
  present: boolean;
  remaining: number | null;
  used: number | null;
  /** null when the bucket reports no ceiling; `unlimited` says which flavour. */
  ceiling: number | null;
  /** The org package answers `cap: -1` for "no ceiling" -- NOT "zero allowed". */
  unlimited: boolean;
  unit: string;
  percentage: number | null;
  available: boolean | undefined;
};

export type QuotaUsage = {
  /** Verbatim payload, so a caller can read a field this module has not learned. */
  payload: Record<string, unknown>;
  userID: string;
  userType: string;
  usageType: string;
  exhausted: boolean;
  buckets: QuotaBucket[];
  /** Sum of every present bucket's remaining. */
  remainingTotal: number;
  /** Fraction (0.01 == 1%). Plan-only, and NOT an exhaustion signal. */
  planUsagePercentage: number | null;
  expiresAt: number | null;
  upgradeUrl: string;
  /** One-line rendering, the same text the log line carries. */
  snapshot: string;
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bucketRaw(usage: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const bucket = usage[key];
    if (bucket && typeof bucket === "object") return bucket as Record<string, unknown>;
  }
  return undefined;
}

function readBuckets(usage: Record<string, unknown>): QuotaBucket[] {
  return QUOTA_BUCKETS.map(({ key, label, keys }) => {
    const raw = bucketRaw(usage, keys);
    if (!raw) {
      return {
        key,
        label,
        present: false,
        remaining: null,
        used: null,
        ceiling: null,
        unlimited: false,
        unit: "credits",
        percentage: null,
        available: undefined,
      };
    }
    const used = finite(raw.used);
    const remaining = finite(raw.remaining);
    // The live payload spells the org package's ceiling `cap`, not `total`.
    const rawCeiling = finite(raw.total ?? raw.cap);
    const unlimited = rawCeiling !== null && rawCeiling < 0;
    const available = typeof raw.available === "boolean" ? raw.available : undefined;
    return {
      key,
      label,
      present: true,
      used,
      remaining,
      ceiling: unlimited ? null : rawCeiling,
      unlimited,
      unit: text(raw.unit) || "credits",
      percentage: finite(raw.percentage),
      available,
    };
  });
}

function totalRemaining(buckets: QuotaBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + (bucket.remaining ?? 0), 0);
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
  const remaining = totalRemaining(readBuckets(usage));
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
  for (const bucket of readBuckets(usage)) {
    if (!bucket.present) continue;
    if (bucket.remaining === null) {
      parts.push(`${bucket.key}=?`);
      continue;
    }
    parts.push(
      bucket.unlimited
        ? `${bucket.key}=${bucket.remaining}/unlimited`
        : `${bucket.key}=${bucket.remaining}/${bucket.ceiling}`,
    );
  }
  if (parts.length === 0) parts.push("buckets=<none>");
  parts.push(`flag=${quotaFlag(usage) ?? "absent"}`);
  const pct = finite(usage.total_usage_percentage ?? usage.totalUsagePercentage);
  // Shown as a percentage for readability. It is a fraction upstream and is
  // deliberately not part of the decision -- see isQuotaExhausted().
  if (pct !== null) parts.push(`planUsage=${(pct * 100).toFixed(1)}%`);
  return parts.join(" ");
}

// Normalises a raw quota response. Public so callers that already hold a payload
// (a test, a cached body) can shape it without fetching.
export function shapeQuota(payload: unknown): QuotaUsage {
  const usage = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const buckets = readBuckets(usage);
  const upgradeUrl = text(usage.upgradeUrl ?? usage.upgrade_url);
  return {
    payload: usage,
    userID: text(usage.user_id ?? usage.userId),
    userType: text(usage.user_type ?? usage.userType),
    usageType: text(usage.usageType ?? usage.usage_type),
    exhausted: isQuotaExhausted(payload),
    buckets,
    remainingTotal: totalRemaining(buckets),
    planUsagePercentage: finite(usage.total_usage_percentage ?? usage.totalUsagePercentage),
    expiresAt: finite(usage.expiresAt ?? usage.expires_at),
    upgradeUrl: upgradeUrl || "https://qoder.com/pricing",
    snapshot: quotaSnapshot(usage),
  };
}

// Throws on any failure. Callers that must fail open want fetchQuotaExhausted().
export async function fetchQuotaUsage(options: QoderProviderOptions): Promise<QuotaUsage> {
  const credentials = await resolveQoderCredentials(options);
  const payload: unknown = await fetchWithTimeout(
    QODER_QUOTA_URL,
    { headers: jsonHeaders({ Authorization: `Bearer ${credentials.access}` }) },
    FETCH_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${await readErrorBody(response)}`.trim());
      }
      return response.json();
    },
  );
  const usage = shapeQuota(payload);
  logPlugin(`quota: exhausted=${usage.exhausted} ${usage.snapshot}`);
  return usage;
}

// Fails open: an unreachable quota endpoint must not paint the whole catalog
// unavailable. qodercli's vEu() returns false on error too.
export async function fetchQuotaExhausted(options: QoderProviderOptions): Promise<boolean> {
  try {
    return (await fetchQuotaUsage(options)).exhausted;
  } catch (error) {
    logPlugin(`quota: ${errorMessage(error)} -- failing open, nothing marked Unavailable`);
    return false;
  }
}
