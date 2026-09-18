import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  fetchQoderAccount,
  getEnvPat,
  type QoderCredentials,
  resolveQoderCredentials,
  storedConnectionToken,
} from "./auth.js";
import { renderQuota } from "./capabilities.js";
import { text } from "./coerce.js";
import type { QoderRegion } from "./constants.js";
import { opencodeConfigFile } from "./json-store.js";
import { describeKeyFile, keyFilePath, keyFileToken } from "./key-file.js";
import { errorMessage } from "./log.js";
import { classifyImportValue } from "./pat-import.js";
import {
  getActivePatString,
  getSelectedPatString,
  listPATs,
  patStoreFile,
  switchPAT,
} from "./pat-store.js";
import { fetchQuotaUsage, type QuotaBucket, type QuotaUsage } from "./quota.js";
import { readSharedApiKey } from "./shared-state.js";

// Standalone CLI surface -- the quota side of the pattern claim.ts set:
// everything the skill script needs, reachable with a plain `node` process and
// no opencode runtime. The .mjs beside skills/qoder-quota/scripts/ is a thin
// wrapper over dist/quota-cli.js, so "which account am I on" and "how many
// credits are left" have ONE answer in both places. It used to be a second
// implementation of the credential chain, the PAT store and the quota buckets,
// and the two copies had already drifted (separate shared bucket here, merged
// one there; env ranked first by the script and last by auth.ts). A divergence
// between surfaces is what --resolve exists to catch, so the surfaces may not
// carry one.
//
// Same rule as the capability reports: the functions never throw, they report
// {output, stderr, data, exitCode} and the wrapper decides how to exit.
// Nothing here prints a token -- only ids, labels and SHA-256 fingerprints.

export type CliReport = {
  /** Text for stdout (human summary, or the JSON body when --json was asked). */
  output: string;
  /** Guidance for stderr -- the "why" and the next command to run. */
  stderr: string;
  data: unknown;
  exitCode: number;
};

// --- the credential walk -----------------------------------------------------

export interface CredentialLayer {
  layer: string;
  token: string;
}

// The auth.ts precedence table spelled as data. resolveQoderCredentials()
// answers WHICH TOKEN the chain produces; this answers which LAYER produced
// it -- the observable --resolve prints and the quota footer names. Keep the
// two in lockstep: same layers, same order, and any change lands in both.
//
// Two deliberate CLI wrinkles over the table:
//   * --pat / --token sit above everything (an explicit CLI act, the same rule
//     by which a store selection outranks passive configuration);
//   * the shared-channel row (auth.ts layer 5) is listed but can only ever be
//     empty in a bare process -- globalThis state belongs to a running
//     opencode. It is shown for the same reason --resolve shows a layer the
//     plugin fills later: the table is the diagnosis of "what is NOT here".
export function credentialLayers(
  explicit: { personalAccessToken?: string; apiKey?: string; region?: QoderRegion } = {},
): CredentialLayer[] {
  const region = explicit.region ?? "global";
  const keyFile = keyFilePath();
  return [
    { layer: "--pat (CLI)", token: explicit.personalAccessToken ?? "" },
    { layer: "--token (CLI)", token: explicit.apiKey ?? "" },
    { layer: "pat-store selection", token: getSelectedPatString(region) ?? "" },
    { layer: "opencode auth.json", token: storedConnectionToken() },
    { layer: "opencode config apiKey", token: configApiKeyFromDisk() },
    { layer: "shared channel (in-process)", token: readSharedApiKey() ?? "" },
    { layer: keyFile || "key file (disabled)", token: keyFileToken(region) },
    { layer: "pat-store active", token: getActivePatString(region) ?? "" },
    { layer: "env (QODER_*)", token: getEnvPat() },
  ];
}

export function standaloneCredential(
  explicit: { personalAccessToken?: string; apiKey?: string; region?: QoderRegion } = {},
): CredentialLayer | null {
  return credentialLayers(explicit).find((row) => row.token !== "") ?? null;
}

// opencode.json(c) holds `apiKey: "{file:/path}"` -- opencode itself expands
// that for the plugin (auth.ts layer 4), but a bare process has nobody, so
// this is the one place the expansion lives. Comments are stripped first:
// this is a regex over JSONC, not a parser, and without the strip a commented
// out apiKey would be resurrected. A value that classifies as a seed LIST (or
// assignment form) feeds the importer, it is not a bearer token -- the skip
// mirrors pat-import's grammar rather than a hand rule.
function stripCommentLines(input: string): string {
  return input
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function configApiKeyFromDisk(): string {
  const candidates = [
    process.env.OPENCODE_CONFIG ?? "",
    opencodeConfigFile("opencode.json"),
    opencodeConfigFile("opencode.jsonc"),
  ];
  for (const file of candidates) {
    if (!file) continue;
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!raw) continue;
    const inline = stripCommentLines(raw).match(
      /"qoder"\s*:[\s\S]{0,600}?"apiKey"\s*:\s*"([^"]+)"/,
    );
    const value = inline?.[1];
    if (!value) continue;
    const fromFile = value.match(/\{file:([^}]+)\}/);
    let resolved = "";
    if (fromFile) {
      try {
        resolved = readFileSync(fromFile[1].replace(/^~(?=\/|$)/, homedir()), "utf8").trim();
      } catch {
        resolved = "";
      }
    } else {
      resolved = value.trim();
    }
    if (!resolved) continue;
    const shape = classifyImportValue(resolved);
    if (shape.kind === "single") return shape.token;
  }
  return "";
}

// A credential with its identity but never its bytes: enough to tell two
// stored PATs apart in a report, not enough to copy one out of a terminal.
export function fingerprint(token: string): string {
  const value = String(token || "");
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// --- quota -------------------------------------------------------------------

export async function runQuotaCli(
  opts: { pat?: string; token?: string; json?: boolean; region?: QoderRegion } = {},
): Promise<CliReport> {
  const region = opts.region ?? "global";
  const explicit = opts.pat
    ? { personalAccessToken: opts.pat, region }
    : opts.token
      ? { apiKey: opts.token, region }
      : { region };
  const chosen = standaloneCredential(explicit);
  if (!chosen) {
    return {
      output: "",
      stderr: [
        `No Qoder credential found. Tried: ${credentialLayers(explicit)
          .map((row) => row.layer)
          .join(", ")}.`,
        "Set one with:  opencode auth login qoder   (or export QODER_PERSONAL_ACCESS_TOKEN)",
        "Pick a stored one with:  node qoder-quota.mjs --pats   then   --use-pat=<id>",
      ].join("\n"),
      data: {},
      exitCode: 1,
    };
  }
  try {
    // Resolve once for the bearer token the account call needs, then let
    // fetchQuotaUsage run its own resolve -- auth.ts memoizes the exchange per
    // (region, PAT) in-process, so the second pass is free and stays the single
    // funnel. Region MUST ride every one of these calls: dropping it here is
    // exactly how a `--region=cn` run silently answered from the international
    // host, which is worse than failing -- it looks like CN works.
    const request = { personalAccessToken: chosen.token, region };
    const credentials = await resolveQoderCredentials(request);
    const usage = await fetchQuotaUsage(request);
    const account = await fetchQoderAccount(credentials.access, region);
    const data = {
      credential: { source: chosen.layer, fingerprint: fingerprint(chosen.token) },
      account: accountProjection(account, usage),
      quota: quotaProjection(usage),
      raw: { quota: usage.payload, user: account },
    };
    if (opts.json) {
      return { output: JSON.stringify(data, null, 2), stderr: "", data, exitCode: 0 };
    }
    const lines = [renderQuota(usage, account)];
    // Which layer answered, spelled out: a stale account name is ambiguous
    // (did the switch land? on the wrong entry?), while "pat-store active"
    // versus "opencode config" says exactly that.
    lines.push(`Via: ${chosen.layer}`);
    if (Object.keys(account).length === 0) {
      lines.push("(userinfo unavailable -- account lines omitted)");
    }
    return { output: lines.join("\n\n"), stderr: "", data, exitCode: 0 };
  } catch (error) {
    return { output: "", stderr: errorMessage(error), data: {}, exitCode: 1 };
  }
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function accountProjection(
  account: Record<string, unknown>,
  usage: QuotaUsage,
): Record<string, unknown> {
  return {
    id: text(usage.userID) || text(pick(account, "id")),
    name: text(pick(account, "name")),
    email: text(pick(account, "email")),
    organization: text(pick(account, "organization_name", "organizationName")),
    organizationId: text(pick(account, "organization_id", "organizationId")),
    userType: usage.userType,
    usageType: usage.usageType,
    createdAt: pick(account, "created_at", "createdAt"),
    source: text(pick(account, "source")),
    avatar: text(pick(account, "avatar")),
    highestTier: pick(account, "is_highest_tier", "isHighestTier"),
  };
}

// The projection keeps the script's historical JSON keys for the buckets,
// whose values are now the SHARED bucket objects from quota.ts -- the shape
// drift this file exists to end.
function quotaProjection(usage: QuotaUsage): Record<string, unknown> {
  const buckets: Record<string, QuotaBucket | null> = {
    userQuota: null,
    addOnQuota: null,
    orgPackage: null,
    sharedPackage: null,
  };
  for (const bucket of usage.buckets) {
    if (bucket.present) buckets[bucket.key] = bucket;
  }
  return {
    exhausted: usage.exhausted,
    remainingTotal: usage.remainingTotal,
    planUsagePercentage: usage.planUsagePercentage,
    expiresAt: usage.expiresAt,
    upgradeUrl: usage.upgradeUrl,
    buckets,
  };
}

// --- probing (--pats) ----------------------------------------------------------

export type ProbeStatus =
  | "ALIVE"
  | "EXHAUSTED"
  | "DEAD"
  | "ACCOUNT-INACTIVE"
  | "UNREACHABLE"
  | "UNKNOWN";

export interface ProbeVerdict {
  status: ProbeStatus;
  remaining?: number;
  email?: string;
  reason?: string;
}

function classifyProbeError(error: unknown): ProbeStatus {
  const message = errorMessage(error);
  if (/not active/i.test(message)) return "ACCOUNT-INACTIVE";
  // The exchange endpoint answers 400 (not 401) to a token it does not accept
  // at all -- verified live; a revoked one lands on 401/403. Any 4xx here means
  // "this credential is not accepted", which is exactly what DEAD is for. Two
  // producers, two message shapes: auth.ts says "PAT exchange failed: 400 ...",
  // quota.ts says "HTTP 404 ..." -- match both, or a revoked PAT lands UNKNOWN
  // and the --use-pat gate loses its whole meaning.
  if (/HTTP 4\d\d|exchange failed:?\s*4\d\d/i.test(message)) return "DEAD";
  if (/network failure|timeout|abort/i.test(message)) return "UNREACHABLE";
  return "UNKNOWN";
}

// One stored PAT's live verdict. A fresh exchange every run is the point: a
// cached job token would keep calling a just-revoked PAT healthy until the
// cache lapsed -- which is also why the CLI dropped its old on-disk token
// cache (a second cache meant a second staleness story).
export async function probePat(pat: string, region: QoderRegion = "global"): Promise<ProbeVerdict> {
  let credentials: QoderCredentials | undefined;
  try {
    credentials = await resolveQoderCredentials({ personalAccessToken: pat, region });
  } catch (error) {
    return { status: classifyProbeError(error), reason: errorMessage(error) };
  }
  try {
    const usage = await fetchQuotaUsage({ personalAccessToken: credentials.access, region });
    const account = await fetchQoderAccount(credentials.access, region);
    return {
      status: usage.exhausted ? "EXHAUSTED" : "ALIVE",
      remaining: usage.remainingTotal,
      email: text(pick(account, "email")) || undefined,
    };
  } catch (error) {
    return { status: classifyProbeError(error), reason: errorMessage(error) };
  }
}

export async function runPatsCli(
  opts: { json?: boolean; region?: QoderRegion } = {},
): Promise<CliReport> {
  const region = opts.region ?? "global";
  const entries = listPATs(region);
  const store = patStoreFile(region);
  if (entries.length === 0) {
    return {
      output: "",
      stderr: noStoreGuidance(store),
      data: { store, entries: [] },
      exitCode: 1,
    };
  }
  // Sequential on purpose: a handful of live exchanges, and a dead-PAT burst
  // against the gateway tells the user nothing extra.
  const rows = [];
  for (const entry of entries) {
    rows.push({
      id: entry.id,
      label: entry.label || "",
      active: !!entry.active,
      email: entry.email || "",
      ...(await probePat(entry.pat, region)),
    });
  }
  const usable = rows.filter((r) => r.status === "ALIVE" || r.status === "EXHAUSTED");
  const data = { store, entries: rows, usableIds: usable.map((r) => r.id) };
  if (opts.json) {
    return {
      output: JSON.stringify(data, null, 2),
      stderr: "",
      data,
      exitCode: usable.length ? 0 : 1,
    };
  }
  const lines: string[] = [`PAT store: ${store}`];
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const marker = r.active ? "*" : " ";
    const who = `${r.id.padEnd(idWidth)}  ${(r.label || "-").padEnd(16)}${r.email ? ` <${r.email}>` : ""}`;
    const tail =
      r.status === "ALIVE" || r.status === "EXHAUSTED"
        ? `  ${r.remaining} credits`
        : `  ${r.reason || ""}`;
    lines.push(`${marker} ${who}  ${String(r.status).padEnd(16)}${tail}`.replace(/\s+$/, ""));
  }
  let stderr = "";
  if (usable.length) {
    const activeOk = usable.find((r) => r.active);
    lines.push("");
    lines.push(
      activeOk
        ? "Active account is healthy. Switch anyway with:  --use-pat=<id>"
        : `Switch to a healthy one:  --use-pat=${usable[0].id}`,
    );
  } else {
    const judged = rows.every((r) => r.status === "ACCOUNT-INACTIVE" || r.status === "DEAD");
    stderr = judged
      ? "No usable PAT: every stored account is dead or its subscription lapsed. Add a PAT for a DIFFERENT account (OPENCODE_QODER_PAT import, or the store file above)."
      : "No PAT confirmed usable: every probe failed to reach or judge the gateway (see reasons above). This is not proof the accounts are dead -- retry, or check connectivity.";
  }
  return { output: lines.join("\n"), stderr, data, exitCode: usable.length ? 0 : 1 };
}

function noStoreGuidance(store: string): string {
  return [
    `No usable PAT store at ${store}.`,
    "Seed one from a shell without a chat:",
    '  OPENCODE_QODER_PAT="pt-aaa,pt-bbb" opencode   (imported at startup)',
    "...or add accounts with the qoder_pat_add tool from a working conversation.",
  ].join("\n");
}

// --- activation (--use-pat) -----------------------------------------------------

export async function runUsePatCli(
  target: string,
  opts: { force?: boolean; json?: boolean; region?: QoderRegion } = {},
): Promise<CliReport> {
  const region = opts.region ?? "global";
  const entries = listPATs(region);
  const store = patStoreFile(region);
  if (entries.length === 0) {
    return { output: "", stderr: noStoreGuidance(store), data: { store }, exitCode: 1 };
  }
  const matches = entries.filter(
    (e) => e.id === target || (e.label || "").toLowerCase() === target.toLowerCase(),
  );
  if (matches.length === 0) {
    return {
      output: "",
      stderr: [
        `No stored PAT matches "${target}". Stored:`,
        ...entries.map((e) => `  ${e.id}  ${e.label || "-"}${e.active ? "  [active]" : ""}`),
      ].join("\n"),
      data: { store },
      exitCode: 1,
    };
  }
  if (matches.length > 1) {
    return {
      output: "",
      stderr: `"${target}" matches several labels -- use an exact id: ${matches.map((m) => m.id).join(", ")}`,
      data: { store },
      exitCode: 1,
    };
  }
  const entry = matches[0];
  const probe = await probePat(entry.pat, region);
  if (probe.status !== "ALIVE" && !opts.force) {
    const lines = [
      `Refusing to activate ${entry.id} (${entry.label}): ${probe.status}${probe.reason ? ` (${probe.reason})` : ""}.`,
    ];
    if (probe.status === "ACCOUNT-INACTIVE")
      lines.push(
        "The whole account is down -- a backup on the SAME account will not help; use one on a different account.",
      );
    if (probe.status === "EXHAUSTED")
      lines.push(
        "Credential is valid but out of credits; a free model may still serve. Re-run with --force to activate anyway.",
      );
    lines.push(
      "Nothing written. --force writes the entry regardless, if you know better than the probe (e.g. UNREACHABLE was really a VPN blip).",
    );
    return {
      output: "",
      stderr: lines.join("\n"),
      data: { store, entry: entry.id, probe },
      exitCode: 1,
    };
  }
  // switchPAT marks active AND selected, which is the point: `active` alone is
  // outranked by a configured apiKey or key file, so a recovery flip would look
  // like it worked while requests kept signing with the poisoned credential.
  switchPAT(entry.id, region);
  const note =
    probe.status === "ALIVE"
      ? `validated live, ${probe.remaining} credits left`
      : `NOT healthy (${probe.status}) -- activated by --force`;
  return {
    output: [
      `Active PAT -> ${entry.id} (${entry.label || "-"}), ${note}.`,
      "Marked active AND selected, so it outranks a configured apiKey/key file too.",
      "A running opencode picks this up on its next request (mtime reload); no restart needed.",
    ].join("\n"),
    stderr: "",
    data: { store, entry: entry.id, probe },
    exitCode: 0,
  };
}

// --- layer table (--resolve) ------------------------------------------------------

// Precedence is the part that fails silently -- a switch that lands while a
// configured credential shadows it, and reading it out of the layers by hand is
// how that goes unnoticed for a session. This prints the credentialLayers()
// walk itself, hashes only, no network -- the offline answer to "I switched
// accounts, why is this still the old one". qoder_auth in a chat is the
// plugin's view of the same chain; a disagreement between the two is a bug in
// one of them, and now there is only one walk to be wrong in.
export function runResolveCli(
  opts: { pat?: string; token?: string; json?: boolean; region?: QoderRegion } = {},
): CliReport {
  const region = opts.region ?? "global";
  const explicit = opts.pat
    ? { personalAccessToken: opts.pat, region }
    : opts.token
      ? { apiKey: opts.token, region }
      : { region };
  const entries = listPATs(region);
  const rows = credentialLayers(explicit);
  const chosen = standaloneCredential(explicit);
  const data = {
    rows: rows.map((row) => ({
      layer: row.layer,
      present: row.token !== "",
      fingerprint: fingerprint(row.token),
    })),
    resolvedVia: chosen?.layer ?? "",
    credential: chosen ? fingerprint(chosen.token) : "",
  };
  if (opts.json) {
    return {
      output: JSON.stringify(data, null, 2),
      stderr: "",
      data,
      exitCode: chosen ? 0 : 1,
    };
  }
  const lines: string[] = [
    "Qoder credential layers (walk == auth.ts precedence, plus CLI-explicit acts):",
  ];
  // padEnd counts UTF-16 units, so CJK labels would break the column -- keep to
  // ASCII here and let the note carry the explanation.
  const row = (n: number, name: string, token: string, note = "") => {
    lines.push(
      `  ${n}. ${name.padEnd(32)} ${(fingerprint(token) || "-").padEnd(12)} ${note}`.trimEnd(),
    );
  };
  const noteFor = (r: CredentialLayer): string => {
    if (r.token) {
      const hit = entries.find((e) => e.pat === r.token);
      return hit ? `${hit.id} (${hit.label || "-"})` : "";
    }
    if (r.layer === "pat-store selection") return "never switched";
    if (r.layer === "opencode config apiKey") return "commented out / absent";
    if (r.layer === "shared channel (in-process)")
      return "in-process only; a bare CLI never fills it";
    if (r.layer === "pat-store active") return "no active entry";
    if (r.layer === "env (QODER_*)") return "";
    // The key-file row names the path in the layer column, so the note carries
    // the state: why a file that exists contributed no token.
    const kind = describeKeyFile();
    if (kind === "list") return "seed list -> feeds store, no token";
    if (kind === "absent") return "no file";
    if (kind === "disabled") return "turned off by 'none'";
    return "";
  };
  rows.forEach((r, i) => {
    row(i + 1, r.layer, r.token, noteFor(r));
  });
  lines.push("");
  if (!chosen) {
    return {
      output: lines.join("\n"),
      stderr: "=> no layer supplied a credential; a chat cannot run.",
      data,
      exitCode: 1,
    };
  }
  lines.push(`=> resolves via: ${chosen.layer}  [${fingerprint(chosen.token)}]`);
  const hit = entries.find((e) => e.pat === chosen.token);
  if (hit) lines.push(`   stored account: ${hit.id} (${hit.label || "-"})`);
  lines.push("");
  lines.push("Hashes only -- a 12-char SHA-256 prefix, never the token.");
  lines.push("No switch happened yet if selection reads 'never switched': a first");
  lines.push("import auto-activates without pinning, so the layers above still win.");
  return { output: lines.join("\n"), stderr: "", data, exitCode: 0 };
}
