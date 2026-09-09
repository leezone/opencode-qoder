#!/usr/bin/env node
// Qoder account + credit quota reader.
//
// Plain Bearer calls against openapi.qoder.sh -- no COSY signing, no deps.
// Reads the same credential layers the opencode-qoder plugin does, caches the
// exchanged job token so repeat lookups do not re-run the PAT exchange.
//
//   node qoder-quota.mjs            human summary
//   node qoder-quota.mjs --json     machine-readable
//   node qoder-quota.mjs --refresh  ignore the cached job token

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENAPI = process.env.QODER_OPENAPI_URL || "https://openapi.qoder.sh";
const EXCHANGE_URL = `${OPENAPI}/api/v1/jobToken/exchange`;
const QUOTA_URL = `${OPENAPI}/api/v2/quota/usage`;
const USERINFO_URL = `${OPENAPI}/api/v1/userinfo`;
const MANAGE_URL = process.env.QODER_MANAGE_URL || "https://qoder.com";

const TIMEOUT_MS = 15_000;
// Re-exchange this long before the token actually dies.
const SKEW_MS = 5 * 60 * 1000;

const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "opencode-qoder-skill",
  "Cosy-Version": "1.1.42",
  "Cosy-ClientType": "5",
};

const PAT_ENV = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"];
const CACHE_FILE = path.join(os.homedir(), ".cache", "opencode-qoder", "job-token.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

if (flag("help")) {
  console.log(
    [
      "Usage: node qoder-quota.mjs [--json] [--refresh] [--pat=<pt-...>] [--token=<jt-...>]",
      "",
      "Reads Qoder credit quota + account info. Exit 0 = data fetched (even if",
      "credits are spent), 1 = nothing usable came back.",
    ].join("\n"),
  );
  process.exit(0);
}

// --- credentials ------------------------------------------------------------

function readIf(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// opencode.jsonc holds `apiKey: "{file:/path}"` -- expand that one pattern so a
// credential configured for the plugin needs no second copy here.
function patFromOpencodeConfig() {
  for (const file of [
    process.env.OPENCODE_CONFIG,
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
  ]) {
    if (!file) continue;
    const text = readIf(file);
    if (!text) continue;
    const inline = text.match(/"qoder"\s*:[\s\S]{0,600}?"apiKey"\s*:\s*"([^"]+)"/);
    const value = inline?.[1];
    if (!value) continue;
    const fromFile = value.match(/\{file:([^}]+)\}/);
    if (fromFile) {
      const expanded = fromFile[1].replace(/^~(?=\/|$)/, os.homedir());
      const content = readIf(expanded).trim();
      if (content) return content;
    } else if (value.startsWith("pt-")) {
      return value;
    }
  }
  return "";
}

// opencode's own credential store, when someone used /connect qoder.
function tokenFromOpencodeAuth() {
  const text = readIf(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
  if (!text) return "";
  try {
    const entry = JSON.parse(text).qoder;
    if (!entry) return "";
    return String(entry.key || entry.access || entry.refresh || "").trim();
  } catch {
    return "";
  }
}

function resolveCredential() {
  const explicitPat = option("pat") || PAT_ENV.map((k) => process.env[k]).find(Boolean) || "";
  if (explicitPat) return { token: explicitPat, source: flag("pat") ? "--pat" : "env" };

  const explicitJob = option("token");
  if (explicitJob) return { token: explicitJob, source: "--token" };

  const fromConfig = patFromOpencodeConfig();
  if (fromConfig) return { token: fromConfig, source: "opencode config" };

  const keyFile = (process.env.QODER_PAT_FILE || "~/.qoderkey_pat").replace(
    /^~(?=\/|$)/,
    os.homedir(),
  );
  const fromFile = readIf(keyFile).trim();
  if (fromFile) return { token: fromFile, source: keyFile };

  const fromAuth = tokenFromOpencodeAuth();
  if (fromAuth) return { token: fromAuth, source: "opencode auth.json" };

  return null;
}

function loadCache(patHash) {
  try {
    const cached = JSON.parse(readIf(CACHE_FILE));
    if (cached?.patHash === patHash && Number(cached.expiresAt) - SKEW_MS > Date.now()) {
      return cached;
    }
  } catch {
    /* cold cache */
  }
  return null;
}

function saveCache(entry) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry), { mode: 0o600 });
  } catch {
    /* cache is an optimisation; a read-only HOME must not break a lookup */
  }
}

async function fetchJson(url, init = {}, label) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error) => {
    throw new Error(`${label}: network failure (${error?.message || error})`);
  });
  const text = await response.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body; handled by the status check below */
  }
  if (!response.ok) {
    const detail =
      body?.message || body?.errorMessage || body?.error || body?.errMsg || text.slice(0, 200);
    throw new Error(
      `${label}: HTTP ${response.status}${detail ? ` ${String(detail).trim()}` : ""}`,
    );
  }
  return body;
}

// A `pt-` PAT must be exchanged for a job token; anything else (a `jt-` token or
// an OAuth access token) is already bearer-ready.
async function jobToken(credential, { forceExchange }) {
  if (!credential.token.startsWith("pt-")) {
    return { token: credential.token, exchanged: false };
  }
  const patHash = crypto.createHash("sha256").update(credential.token).digest("hex").slice(0, 16);
  if (!forceExchange) {
    const cached = loadCache(patHash);
    if (cached) return { token: cached.token, exchanged: false, cached: true };
  }
  const data = await fetchJson(
    EXCHANGE_URL,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ personal_token: credential.token }),
    },
    "PAT exchange",
  );
  if (!data?.token) throw new Error("PAT exchange returned no job token");
  const parsed = Date.parse(data.expires_at || "");
  const expiresAt = Number.isFinite(parsed)
    ? parsed
    : Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 86_400_000);
  saveCache({ patHash, token: data.token, expiresAt });
  return { token: data.token, exchanged: true };
}

// --- shaping ----------------------------------------------------------------

// Upstream spells keys both ways across versions; the plugin's quota.ts keeps a
// camel/snake list for the same reason.
function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function bucket(raw, { unlimitedCapIsNegative = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const used = num(pick(raw, "used"));
  const remaining = num(pick(raw, "remaining"));
  const total = num(pick(raw, "total"));
  // The org package reports its ceiling as `cap`, and -1 there means
  // "no ceiling", not "zero allowed".
  const rawCap = num(pick(raw, "total", "cap"));
  const cap = unlimitedCapIsNegative && rawCap !== null && rawCap < 0 ? null : rawCap;
  const ceiling = total ?? cap;
  return {
    used,
    remaining,
    ceiling,
    unlimited: ceiling === null,
    unit: String(pick(raw, "unit") || "credits"),
    available: pick(raw, "available"),
    percentage: num(pick(raw, "percentage")),
  };
}

function formatBucket(name, b, out) {
  if (!b) return;
  if (b.unlimited) {
    out.push(
      `${name}: ${b.remaining ?? "?"} left (no ceiling set)${
        b.used !== null ? `, ${b.used} used` : ""
      }`,
    );
    return;
  }
  const left = b.remaining ?? 0;
  const pct = b.percentage !== null ? ` (${(b.percentage * 100).toFixed(1)}% used)` : "";
  out.push(`${name}: ${left} / ${b.ceiling} left${pct}${b.unit ? ` ${b.unit}` : ""}`);
}

async function fetchAccount(token) {
  const headers = { ...HEADERS, Authorization: `Bearer ${token}` };
  // userinfo is identity-only; a failure there must not cost the quota answer.
  const [quotaSettled, userSettled] = await Promise.allSettled([
    fetchJson(QUOTA_URL, { headers }, "quota"),
    fetchJson(USERINFO_URL, { headers }, "userinfo"),
  ]);
  if (quotaSettled.status === "rejected") throw quotaSettled.reason;
  return {
    quota: quotaSettled.value || {},
    user: userSettled.status === "fulfilled" ? userSettled.value : null,
    userError: userSettled.status === "rejected" ? String(userSettled.reason?.message) : "",
  };
}

async function main() {
  const credential = resolveCredential();
  if (!credential) {
    console.error(
      "No Qoder credential found. Tried: --pat, " +
        PAT_ENV.join(", ") +
        ", opencode.jsonc provider.qoder.options.apiKey, ~/.qoderkey_pat, opencode auth.json.",
    );
    console.error(
      "Set one with:  opencode auth login qoder   (or export QODER_PERSONAL_ACCESS_TOKEN)",
    );
    process.exit(1);
  }

  let { token, cached } = await jobToken(credential, { forceExchange: flag("refresh") });
  let account;
  try {
    account = await fetchAccount(token);
  } catch (error) {
    // A cached job token can be revoked server-side well before its stated
    // expiry, so only that case is worth re-exchanging: a fresh token that
    // still gets 401 means the credential itself is bad, and retrying would
    // just re-run the exchange.
    const unauthorized = /HTTP 401|not active/i.test(String(error?.message || error));
    if (!unauthorized || !cached || !credential.token.startsWith("pt-")) throw error;
    ({ token, cached } = await jobToken(credential, { forceExchange: true }));
    account = await fetchAccount(token);
  }
  const { quota, user, userError } = account;

  const userQuota = bucket(pick(quota, "userQuota", "user_quota"));
  const addOn = bucket(pick(quota, "addOnQuota", "add_on_quota"));
  const org = bucket(pick(quota, "orgResourcePackage", "org_resource_package"), {
    unlimitedCapIsNegative: true,
  });
  const shared = bucket(pick(quota, "sharedQuota", "shared_quota"));

  const remainingTotal = [userQuota, addOn, org, shared].reduce(
    (sum, b) => (b && num(b.remaining) !== null ? sum + b.remaining : sum),
    0,
  );
  const flagExceeded = pick(quota, "isQuotaExceeded", "is_quota_exceeded");
  const exceeded = typeof flagExceeded === "boolean" ? flagExceeded : remainingTotal <= 0;

  const expiresAt = num(pick(quota, "expiresAt", "expires_at"));
  const planUsage = num(pick(quota, "totalUsagePercentage", "total_usage_percentage"));

  if (flag("json")) {
    console.log(
      JSON.stringify(
        {
          credential: { source: credential.source, jobTokenCached: !!cached },
          account: {
            id: pick(quota, "userId", "user_id") ?? pick(user, "id"),
            name: pick(user, "name"),
            email: pick(user, "email"),
            organization: pick(user, "organization_name", "organizationName"),
            organizationId: pick(user, "organization_id", "organizationId"),
            userType: pick(quota, "userType", "user_type"),
            usageType: pick(quota, "usageType", "usage_type"),
            createdAt: pick(user, "created_at", "createdAt"),
            source: pick(user, "source"),
            avatar: pick(user, "avatar"),
            highestTier: pick(user, "is_highest_tier", "isHighestTier"),
          },
          quota: {
            exhausted: exceeded,
            remainingTotal,
            planUsagePercentage: planUsage,
            expiresAt,
            upgradeUrl: pick(quota, "upgradeUrl", "upgrade_url") || `${MANAGE_URL}/pricing`,
            buckets: { userQuota, addOnQuota: addOn, orgResourcePackage: org, sharedQuota: shared },
          },
          raw: { quota, user },
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [];
  const acct = [
    pick(user, "name") || pick(quota, "userType", "user_type") || "Qoder account",
    pick(user, "email") ? `<${pick(user, "email")}>` : "",
  ]
    .filter(Boolean)
    .join(" ");
  lines.push(`Account:   ${acct}`);
  if (pick(user, "organization_name")) lines.push(`Org:       ${pick(user, "organization_name")}`);
  lines.push(
    `Plan:      ${pick(quota, "userType", "user_type") || "?"} / ${
      pick(quota, "usageType", "usage_type") || "credits"
    }`,
  );
  lines.push("");
  lines.push("Credits:");
  const before = lines.length;
  formatBucket("  plan          ", userQuota, lines);
  formatBucket("  add-on        ", addOn, lines);
  formatBucket("  org package   ", org, lines);
  formatBucket("  shared        ", shared, lines);
  if (lines.length === before) lines.push("  (no quota buckets in response)");
  lines.push("");
  lines.push(`Total left: ${remainingTotal}${exceeded ? "  -- EXHAUSTED" : ""}`);
  if (planUsage !== null) {
    lines.push(`Plan usage: ${(planUsage * 100).toFixed(1)}%`);
  }
  if (expiresAt) {
    lines.push(
      `Renews:    ${new Date(expiresAt).toLocaleString("sv", { hour12: false }).replace("T", " ")}`,
    );
  }
  if (exceeded) {
    lines.push(`Upgrade:   ${pick(quota, "upgradeUrl", "upgrade_url") || `${MANAGE_URL}/pricing`}`);
  }
  if (userError) lines.push(`(userinfo unavailable: ${userError})`);
  console.log(lines.join("\n"));
}

await main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
