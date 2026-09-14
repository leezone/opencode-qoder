#!/usr/bin/env node
// Qoder account + credit quota reader, and the out-of-band PAT-store recovery
// hatch (see --pats / --use-pat under Usage).
//
// Plain Bearer calls against openapi.qoder.sh -- no COSY signing, no deps.
// Reads the same credential layers, in the same order, as the opencode-qoder
// plugin does -- an explicit --pat/--token, then the PAT store's selected entry,
// the configured apiKey, the key file, the store's active entry, auth.json -- so
// "which account am I on" has one answer. Caches the exchanged job token so
// repeat lookups do not re-run the PAT exchange.
//
//   node qoder-quota.mjs            human summary
//   node qoder-quota.mjs --json     machine-readable
//   node qoder-quota.mjs --refresh  ignore the cached job token
//   node qoder-quota.mjs --pats     probe every PAT in the plugin's store
//   node qoder-quota.mjs --use-pat=<id>   validate it, then select + activate it

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
      "       node qoder-quota.mjs --pats",
      "       node qoder-quota.mjs --use-pat=<id|label> [--force]",
      "       node qoder-quota.mjs --resolve",
      "",
      "Reads Qoder credit quota + account info. Exit 0 = data fetched (even if",
      "credits are spent), 1 = nothing usable came back.",
      "",
      "--resolve prints which credential layer answers, with no network call and",
      "no token bytes -- the offline answer to 'I switched accounts, why is this",
      "still the old one'. It ranks the store's selected entry above a",
      "configured apiKey/key file, the same way auth.ts does.",
      "",
      "--pats and --use-pat are the shell-side recovery hatch for a dead ACTIVE",
      "PAT: with no credential no chat can run (not even the free lite model --",
      "zero credits is still signed auth), which also puts the in-conversation",
      "switch tool out of reach. These modes need no chat: they probe every PAT",
      "in the plugin's store with a live exchange + quota read (both unmetered",
      "identity endpoints) and can rewrite which entry is active AND selected. The",
      "plugin re-reads the store by mtime, so a switch applies to a running",
      "opencode without a restart.",
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

// Shapes a credential with its identity but never its bytes: enough to tell two
// stored PATs apart in a report, not enough to copy one out of a terminal.
function fingerprint(token) {
  const value = String(token || "");
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// opencode.jsonc holds `apiKey: "{file:/path}"` -- expand that one pattern so a
// credential configured for the plugin needs no second copy here. Comment lines
// are dropped first: this is a regex over JSONC, not a JSONC parser, and without
// the strip it would happily resurrect an apiKey the user just commented out.
function stripCommentLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function patFromOpencodeConfig() {
  for (const file of [
    process.env.OPENCODE_CONFIG,
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
  ]) {
    if (!file) continue;
    const text = readIf(file);
    if (!text) continue;
    const inline = stripCommentLines(text).match(
      /"qoder"\s*:[\s\S]{0,600}?"apiKey"\s*:\s*"([^"]+)"/,
    );
    const value = inline?.[1];
    if (!value) continue;
    const fromFile = value.match(/\{file:([^}]+)\}/);
    const resolved = fromFile
      ? readIf(fromFile[1].replace(/^~(?=\/|$)/, os.homedir())).trim()
      : value.trim();
    if (!resolved) continue;
    // Same skip the plugin applies at this layer: a config pointed at a
    // multi-token seed file is feeding the importer, and sending the whole list
    // as a bearer token only buys a 401.
    const shape = classifySeed(resolved);
    if (shape.kind === "single") return shape.token;
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

// Port of the plugin's classifyImportValue (pat-import.ts). The ROLE split is
// what the credential layers depend on: a LIST -- or anything written in the
// `OPENCODE_QODER_PAT=` assignment form -- is importer input, never a bearer
// token, so the layer that found it contributes nothing and the next one decides.
const SEGMENT_SPLIT = /[;,\r\n]/;
const ASSIGNMENT = /^(?:export\s+)?OPENCODE_QODER_PAT\s*=\s*/;

function seedSegments(value) {
  const trimmed = String(value ?? "").trim();
  const assigned = ASSIGNMENT.test(trimmed);
  let body = assigned ? trimmed.replace(ASSIGNMENT, "").trim() : trimmed;
  if (assigned && body.length > 1) {
    const quote = body[0];
    if ((quote === '"' || quote === "'") && body.endsWith(quote)) body = body.slice(1, -1);
  }
  const segments = body
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && !segment.startsWith("#"));
  return { segments, assigned };
}

function classifySeed(value) {
  const { segments, assigned } = seedSegments(value);
  if (segments.length === 0) return { kind: "empty", token: "" };
  if (!assigned && segments.length === 1) return { kind: "single", token: segments[0] };
  return { kind: "list", token: "" };
}

// The key file the plugin would read: OPENCODE_QODER_KEY_FILE, then the legacy
// QODER_PAT_FILE, then ~/.qoderkey_env. "none" turns the layer off, as it does
// in the plugin, so a shell that set the variable to empty does not silently
// re-point the lookup at a file nobody meant to use.
function keyFilePath() {
  const configured = (process.env.OPENCODE_QODER_KEY_FILE || process.env.QODER_PAT_FILE || "").trim();
  if (configured.toLowerCase() === "none") return "";
  return (configured || "~/.qoderkey_env").replace(/^~(?=\/|$)/, os.homedir());
}

// Key-file content -> the one credential the plugin would actually sign with,
// mirroring refreshKeyFile()'s variable priority: OPENCODE_QODER_PAT wins, and
// because it wins AS A SEED it yields no token here; only when that variable is
// absent does QODER_PERSONAL_ACCESS_TOKEN act as the single credential; with
// neither, the bare file is the token. Checking the single variable first would
// hand back a stale line-1 token while the plugin runs on the store -- the two
// readers must agree on which entry is live.
function tokenFromKeyFile(content) {
  const text = String(content ?? "").trim();
  if (!text) return "";
  const hasVar = (name) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(text);
  const assignment = (name) => {
    const m = text.match(
      new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`, "m"),
    );
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
  };
  if (hasVar("OPENCODE_QODER_PAT")) return classifySeed(assignment("OPENCODE_QODER_PAT")).token;
  if (hasVar("QODER_PERSONAL_ACCESS_TOKEN"))
    return classifySeed(assignment("QODER_PERSONAL_ACCESS_TOKEN")).token;
  return classifySeed(text).token;
}

// The store entry the plugin would sign with for a given layer. `selection`
// needs BOTH flags, exactly like getSelectedPatString(): an entry a later switch
// deactivated keeps its stale `selected` and must stay inert.
function patFromStore(layer) {
  const store = readPatStore();
  if (!store || !Array.isArray(store.entries)) return "";
  const entry =
    layer === "selection"
      ? store.entries.find((e) => e.active && e.selected)
      : store.entries.find((e) => e.active);
  return String(entry?.pat || "").trim();
}

function resolveCredential() {
  const explicitPat = option("pat") || PAT_ENV.map((k) => process.env[k]).find(Boolean) || "";
  if (explicitPat) return { token: explicitPat, source: flag("pat") ? "--pat" : "env" };

  const explicitJob = option("token");
  if (explicitJob) return { token: explicitJob, source: "--token" };

  // An in-conversation qoder_pat_switch outranks every passive source, config
  // included -- the same rule the plugin's resolution chain encodes.
  const selected = patFromStore("selection");
  if (selected) return { token: selected, source: "pat-store selection" };

  // Layer 3 of auth.ts: what `/connect qoder` persisted. Above the config so a
  // logged-in connection is not silently overridden by a leftover apiKey.
  const fromAuth = tokenFromOpencodeAuth();
  if (fromAuth) return { token: fromAuth, source: "opencode auth.json" };

  const fromConfig = patFromOpencodeConfig();
  if (fromConfig) return { token: fromConfig, source: "opencode config" };

  const keyFile = keyFilePath();
  const fromFile = keyFile ? tokenFromKeyFile(readIf(keyFile)) : "";
  if (fromFile) return { token: fromFile, source: keyFile };

  const active = patFromStore("active");
  if (active) return { token: active, source: "pat-store active" };

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

// --- PAT store: the shell-side recovery hatch --------------------------------
//
// The plugin keeps stored accounts at $XDG_CONFIG_HOME/opencode/qoder-pats.json
// (the `active` entry signs requests, and a `selected` one outranks any
// configured credential). These helpers read and rewrite that file directly, so
// recovery works with no running opencode and no working credential. The token
// VALUES are never printed -- only ids/labels.

function patStorePath() {
  const base = (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")).trim();
  return path.join(base, "opencode", "qoder-pats.json");
}

function readPatStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(patStorePath(), "utf8"));
    return raw && Array.isArray(raw.entries) ? raw : null;
  } catch {
    return null; // absent or corrupt -- the caller decides whether that is fatal
  }
}

// Flip `active` AND pin `selected`, mirroring the plugin's switchPAT(), then
// rewrite the whole file so any other top-level keys survive. Pinning matters:
// `active` alone is outranked by a configured apiKey or key file, so a recovery
// flip would look like it worked while requests kept signing with the poisoned
// credential. An explicit act has to outrank passive configuration here too.
// Last-writer-wins against a concurrent plugin write -- the same hazard a hand
// edit carries, acceptable for a tool a human runs deliberately.
function writePatStoreActive(store, targetId) {
  const next = {
    ...store,
    entries: store.entries.map((e) => ({
      ...e,
      active: e.id === targetId,
      selected: e.id === targetId,
    })),
  };
  const file = patStorePath();
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* a filesystem without POSIX bits; the per-user dir already protects it */
  }
}

// The credit numbers, shared by the quota report and the probe so "usable" means
// the same thing in both.
function creditSummary(quota) {
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
  return { userQuota, addOn, org, shared, remainingTotal, exceeded };
}

function classifyProbeError(error) {
  const message = String((error && error.message) || error);
  if (/not active/i.test(message)) return "ACCOUNT-INACTIVE";
  // The exchange endpoint answers 400 (not 401) to a token it does not accept
  // at all -- verified live; a revoked one lands on 401/403. Any 4xx here means
  // "this credential is not accepted", which is exactly what DEAD is for.
  if (/HTTP 4\d\d/i.test(message)) return "DEAD";
  if (/network failure|timeout|abort/i.test(message)) return "UNREACHABLE";
  return "UNKNOWN";
}

// One stored PAT's live verdict. forceExchange is the point: a CACHED job token
// would keep calling a just-revoked PAT healthy until the cache lapsed.
//   ALIVE            credential good, credits left
//   EXHAUSTED        credential good, zero credits (a free model may still serve)
//   DEAD             the PAT itself was rejected (revoked / wrong)
//   ACCOUNT-INACTIVE the whole account is down -- only a PAT on ANOTHER account helps
//   UNREACHABLE / UNKNOWN   transient; the file is never touched on these
async function probePAT(pat) {
  let token;
  try {
    ({ token } = await jobToken({ token: pat }, { forceExchange: true }));
  } catch (error) {
    return { status: classifyProbeError(error), reason: String((error && error.message) || error) };
  }
  try {
    const account = await fetchAccount(token);
    const summary = creditSummary(account.quota || {});
    return {
      status: summary.exhausted ? "EXHAUSTED" : "ALIVE",
      remaining: summary.remainingTotal,
      email: pick(account.user, "email") || "",
    };
  } catch (error) {
    return { status: classifyProbeError(error), reason: String((error && error.message) || error) };
  }
}

function noStoreGuidance() {
  console.error(`No usable PAT store at ${patStorePath()}.`);
  console.error("Seed one from a shell without a chat:");
  console.error('  OPENCODE_QODER_PAT="pt-aaa,pt-bbb" opencode   (imported at startup)');
  console.error("...or add accounts with the qoder_pat_add tool from a working conversation.");
}

// --pats: probe every stored account, report which are usable.
async function patsMain() {
  const store = readPatStore();
  if (!store || store.entries.length === 0) {
    noStoreGuidance();
    process.exit(1);
  }
  // Sequential on purpose: a handful of live exchanges, and a dead-PAT burst
  // against the gateway tells the user nothing extra.
  const rows = [];
  for (const entry of store.entries) {
    rows.push({
      id: entry.id,
      label: entry.label || "",
      active: !!entry.active,
      email: entry.email || "",
      ...(await probePAT(entry.pat)),
    });
  }
  const usable = rows.filter((r) => r.status === "ALIVE" || r.status === "EXHAUSTED");
  if (flag("json")) {
    console.log(JSON.stringify({ store: patStorePath(), entries: rows, usableIds: usable.map((r) => r.id) }, null, 2));
    process.exit(usable.length ? 0 : 1);
  }
  console.log(`PAT store: ${patStorePath()}`);
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const marker = r.active ? "*" : " ";
    const who = `${r.id.padEnd(idWidth)}  ${(r.label || "-").padEnd(16)}${r.email ? ` <${r.email}>` : ""}`;
    const tail =
      r.status === "ALIVE" || r.status === "EXHAUSTED"
        ? `  ${r.remaining} credits`
        : `  ${r.reason || ""}`;
    console.log(`${marker} ${who}  ${r.status.padEnd(16)}${tail}`.replace(/\s+$/, ""));
  }
  console.log("");
  if (usable.length) {
    const activeOk = usable.find((r) => r.active);
    console.log(
      activeOk
        ? "Active account is healthy. Switch anyway with:  --use-pat=<id>"
        : `Switch to a healthy one:  --use-pat=${usable[0].id}`,
    );
  } else {
    const judged = rows.every((r) => r.status === "ACCOUNT-INACTIVE" || r.status === "DEAD");
    console.error(
      judged
        ? "No usable PAT: every stored account is dead or its subscription lapsed. Add a PAT for a DIFFERENT account (OPENCODE_QODER_PAT import, or ~/.config/opencode/qoder-pats.json)."
        : "No PAT confirmed usable: every probe failed to reach or judge the gateway (see reasons above). This is not proof the accounts are dead -- retry, or check connectivity.",
    );
  }
  process.exit(usable.length ? 0 : 1);
}

// --use-pat=<id|label>: validate, then make it active. The store is never
// written for a DEAD/ACCOUNT-INACTIVE/UNREACHABLE target unless --force is given
// (and never for UNKNOWN -- activating an unproven id would just move the dead
// end). A confirmed switch needs no opencode restart (the plugin reloads by mtime).
async function usePatMain(target) {
  const store = readPatStore();
  if (!store || store.entries.length === 0) {
    noStoreGuidance();
    process.exit(1);
  }
  const matches = store.entries.filter(
    (e) => e.id === target || (e.label || "").toLowerCase() === target.toLowerCase(),
  );
  if (matches.length === 0) {
    console.error(`No stored PAT matches "${target}". Stored:`);
    for (const e of store.entries) console.error(`  ${e.id}  ${e.label || "-"}${e.active ? "  [active]" : ""}`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`"${target}" matches several labels -- use an exact id: ${matches.map((m) => m.id).join(", ")}`);
    process.exit(1);
  }
  const entry = matches[0];
  const probe = await probePAT(entry.pat);
  const force = flag("force");
  if (probe.status !== "ALIVE" && !force) {
    console.error(`Refusing to activate ${entry.id} (${entry.label}): ${probe.status}${probe.reason ? ` (${probe.reason})` : ""}.`);
    if (probe.status === "ACCOUNT-INACTIVE")
      console.error("The whole account is down -- a backup on the SAME account will not help; use one on a different account.");
    if (probe.status === "EXHAUSTED")
      console.error("Credential is valid but out of credits; a free model may still serve. Re-run with --force to activate anyway.");
    console.error("Nothing written. --force writes the entry regardless, if you know better than the probe (e.g. UNREACHABLE was really a VPN blip).");
    process.exit(1);
  }
  writePatStoreActive(store, entry.id);
  const note = probe.status === "ALIVE" ? `validated live, ${probe.remaining} credits left` : `NOT healthy (${probe.status}) -- activated by --force`;
  console.log(`Active PAT -> ${entry.id} (${entry.label || "-"}), ${note}.`);
  console.log("Marked active AND selected, so it outranks a configured apiKey/key file too.");
  console.log("A running opencode picks this up on its next request (mtime reload); no restart needed.");
}

// A store entry's "id (label)" for a token, or "" when the token came from
// outside the store. Lets the layer table name the ACCOUNT, not just a hash.
function labelOf(entries, token) {
  const hit = entries.find((e) => e.pat === token);
  return hit ? `${hit.id} (${hit.label || "-"})` : "not a stored PAT";
}

// --resolve: print the credential layer table with no network call. Precedence
// is the part that fails silently -- a switch that lands while a configured
// credential shadows it -- and reading it out of the two codebases by hand is
// how that goes unnoticed for a session. The order here mirrors auth.ts:
// explicit --pat/--token/env, store selection, config apiKey, key file, store
// active, auth.json. `qoder_auth` in a chat is the plugin's own view of the same
// chain; a disagreement between the two is a bug in one of them.
function resolveMain() {
  const entries = readPatStore()?.entries ?? [];
  const selected = patFromStore("selection");
  const active = patFromStore("active");
  const fromConfig = patFromOpencodeConfig();
  const keyFile = keyFilePath();
  const fromFile = keyFile ? tokenFromKeyFile(readIf(keyFile)) : "";
  const chosen = resolveCredential();

  // padEnd counts UTF-16 units, so CJK labels would break the column -- keep to
  // ASCII here and let the note carry the explanation.
  const row = (n, name, token, note = "") =>
    console.log(
      `  ${n}. ${String(name).padEnd(32)} ${String(token ? fingerprint(token) : "-").padEnd(12)} ${note}`,
    );

  console.log("Qoder credential layers (script order == auth.ts order):");
  row(1, "--pat / QODER_* env (CLI)", option("pat") || PAT_ENV.map((k) => process.env[k]).find(Boolean));
  row(2, "pat-store selection", selected, selected ? labelOf(entries, selected) : "never switched");
  row(3, "opencode auth.json", tokenFromOpencodeAuth());
  row(4, "opencode config apiKey", fromConfig, fromConfig ? "" : "commented out / absent");
  row(
    5,
    keyFile || "key file (disabled)",
    fromFile,
    !keyFile ? "turned off by 'none'" : fromFile ? "" : "seed list -> feeds store, no token",
  );
  row(6, "pat-store active", active, active ? labelOf(entries, active) : "no active entry");
  console.log("");

  if (!chosen) {
    console.log("=> no layer supplied a credential; a chat cannot run.");
    process.exit(1);
  }
  console.log(`=> resolves via: ${chosen.source}  [${fingerprint(chosen.token)}]`);
  const hit = entries.find((e) => e.pat === chosen.token);
  if (hit) console.log(`   stored account: ${hit.id} (${hit.label || "-"})`);
  console.log("");
  console.log("Hashes only -- a 12-char SHA-256 prefix, never the token.");
  console.log("No switch happened yet if selection reads 'never switched': a first");
  console.log("import auto-activates without pinning, so the layers above still win.");
}

async function main() {
  if (flag("resolve")) return resolveMain();
  if (flag("pats")) return patsMain();
  const target = option("use-pat");
  if (target) return usePatMain(target);

  const credential = resolveCredential();
  if (!credential) {
    const tried = [
      "--pat",
      ...PAT_ENV,
      `selected entry of ${patStorePath()}`,
      "opencode.jsonc provider.qoder.options.apiKey",
      keyFilePath() || "key file (disabled)",
      "active entry of the PAT store",
      "opencode auth.json",
    ].join(", ");
    console.error(`No Qoder credential found. Tried: ${tried}.`);
    console.error(
      "Set one with:  opencode auth login qoder   (or export QODER_PERSONAL_ACCESS_TOKEN)",
    );
    console.error(
      "Pick a stored one with:  node qoder-quota.mjs --pats   then   --use-pat=<id>",
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

  const { userQuota, addOn, org, shared, remainingTotal, exceeded } = creditSummary(quota);

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
  // Which layer answered, spelled out: a stale account name is ambiguous (is
  // this the switch not landing, or the switch landing on the wrong entry?),
  // while "pat-store active" versus "opencode config" says exactly that.
  lines.push(`Via:       ${credential.source}`);
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
