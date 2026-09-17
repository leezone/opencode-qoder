import { type QoderProviderOptions, regionOf, resolveQoderCredentials } from "./auth.js";
import { nonEmptyString, text } from "./coerce.js";
import {
  QODER_CLAIM_ENV,
  QODER_CLAIM_TIMEOUT_MS,
  type QoderRegion,
  resolveEndpoints,
  stateFiles,
} from "./constants.js";
import { readEnv } from "./env.js";
import { fetchWithTimeout, jsonHeaders, readErrorBody } from "./http.js";
import { opencodeConfigFile, readJsonFile, writeJsonFile } from "./json-store.js";
import { errorMessage, logPlugin } from "./log.js";
import { listPATs } from "./pat-store.js";

// --- The promotional campaign surface ("签到领积分") --------------------------
//
// Everything Qoder's daily-reward activity owns lives in this file: the two
// endpoints, the payload vocabulary, the fallback ladder and the rendering. The
// module is a leaf. Nothing on the model path, the catalog, the quota reader,
// the transform layer or the credential chain imports it -- the dependency
// points one way, from index.ts's tool table to here, and the isolation test in
// __tests__/claim.test.ts fails the build if a second importer ever appears.
// That is what "the marketing activity can be pulled offline without touching
// the provider" means in practice: delete this file and its wiring and the
// plugin still does everything it did before.
//
// The contract was recovered from qodercli's own bundle, where `/claim` is a
// SERVER-DELIVERED "dynamic command": the campaign list carries the command
// definition, and for qodercli the claim logic arrives as remote JavaScript
// (`campaigns[].placements[type=CMD].commands[].js`) that the CLI then executes.
// This module deliberately does not replicate that. It is a plain Bearer JSON
// client for two endpoints, so a campaign refresh can rename a field or move
// its schedule and nothing here ever evaluates code from a promo service.
//
//   GET  /sash/api/v1/me/campaigns            -> {showCampaign, claimable, campaigns[]}
//   POST /sash/api/v1/me/campaigns/{id}/claim -> {status, reward}
//
// Three rules hold throughout:
//   1. The SERVER decides eligibility and the daily window (campaigns[].startAt
//      /endAt). "Noon, once a day" is a property of the current campaign, not a
//      constant in this file -- a promo that moves its window needs no change.
//   2. No public function throws. A scheduled run and a model both need an ANSWER,
//      and a promo failure must never be able to look like a plugin failure.
//   3. The only state written is this module's own file: never the quota flag,
//      never the catalog, never a credential.

// --- kill switch -------------------------------------------------------------

const OFF = new Set(["0", "off", "false", "none", "disable", "disabled"]);

// Read live rather than at import time: the switch has to work inside an
// already-running opencode, and an activity pulled mid-session should be one
// env edit away from invisible.
export function claimDisabled(): boolean {
  return OFF.has(readEnv(QODER_CLAIM_ENV).toLowerCase());
}

// --- payload vocabulary ------------------------------------------------------

// Upstream spellings. UNKNOWN is the defensive one: an unrecognised value is
// reported as itself and never claimed on, rather than being read as CLAIMABLE.
export type ClaimStatus =
  | "CLAIMABLE"
  | "CLAIMED"
  | "NOT_ELIGIBLE"
  | "BLOCKED"
  | "REVOKED"
  | "UNKNOWN";

const CLAIM_STATUSES = new Set(["CLAIMABLE", "CLAIMED", "NOT_ELIGIBLE", "BLOCKED", "REVOKED"]);

export interface CampaignBenefit {
  /** e.g. CREDITS */
  kind: string;
  amount: number | null;
  /** Restriction as delivered, e.g. C_S_U_SERIES -- kept visible, never folded away */
  scope: string;
  /** When the AWARD itself dies (a promo grant is often a day pass), ISO. */
  validUntil: string;
}

export interface Campaign {
  id: string;
  key: string;
  actionType: string;
  status: ClaimStatus;
  rawStatus: string;
  /** Epoch SECONDS, as delivered; null when the payload omits it. */
  startAt: number | null;
  endAt: number | null;
  benefit: CampaignBenefit | null;
  title: string;
  description: string;
  detailUrl: string;
}

export interface CampaignList {
  userID: string;
  showCampaign: boolean;
  /** The list's own "anything claimable right now" flag, kept verbatim. */
  claimable: boolean;
  campaigns: Campaign[];
  /**
   * "Nothing to do here" -- and explicitly NOT an error. This is the ordinary
   * answer once a campaign is withdrawn or merely hidden, which is what the
   * fallback ladder keys off.
   */
  offline: boolean;
  reason: string;
}

export type ClaimOutcome =
  | "CLAIMED"
  | "ALREADY_CLAIMED"
  | "NOT_ELIGIBLE"
  | "WINDOW_CLOSED"
  | "SERVICE_UNAVAILABLE"
  | "OFFLINE"
  | "SKIPPED_LOCAL"
  | "DISABLED"
  | "ERROR";

export interface CampaignAttempt {
  account: string;
  outcome: ClaimOutcome;
  message: string;
  campaignId?: string;
  awarded?: number | null;
}

export interface ClaimReport {
  output: string;
  data: {
    attempts: CampaignAttempt[];
    claimed: number;
    cooldownUntil: number | null;
    disabled: boolean;
  };
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochSeconds(value: unknown): number | null {
  const n = finite(value);
  // Upstream is in seconds. A value this large can only be milliseconds, so
  // normalise rather than render an absurd 1970 date.
  if (n === null || n <= 0) return null;
  return n > 1e11 ? Math.round(n / 1000) : n;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The campaign list is internationalised and every placement repeats the same
// content block, so the first block that carries either language wins. Chinese
// first: this surface exists for a Qoder CN account and the README ships a zh
// edition. Falls through to en, then to "".
function localizedContent(campaign: Record<string, unknown>): Record<string, unknown> {
  const placements = Array.isArray(campaign.placements) ? campaign.placements : [];
  for (const lang of ["zh", "en"]) {
    for (const entry of placements) {
      const field = asRecord(asRecord(asRecord(entry)?.content)?.[lang]);
      if (field && Object.keys(field).length > 0) return field;
    }
  }
  return {};
}

function readBenefit(raw: Record<string, unknown> | undefined): CampaignBenefit | null {
  if (!raw) return null;
  const kind = text(raw.kind);
  const amount = finite(raw.amount);
  // modelSeries is a nested object upstream, so it goes through asRecord rather
  // than an optional chain, which would leave it typed as unknown.
  const scope = text(asRecord(asRecord(raw.modelScope)?.modelSeries)?.key);
  const validUntil = text(asRecord(raw.validity)?.fixedEnd);
  if (!kind && amount === null && !scope && !validUntil) return null;
  return { kind, amount, scope, validUntil };
}

export function shapeCampaignList(payload: unknown): CampaignList {
  const body = asRecord(payload) ?? {};
  const showCampaign = body.showCampaign === true;
  const claimable = body.claimable === true;
  const rawList = Array.isArray(body.campaigns) ? body.campaigns : [];

  const campaigns: Campaign[] = [];
  for (const entry of rawList) {
    const campaign = asRecord(entry);
    const id = text(campaign?.campaignId).trim();
    if (!campaign || !id) continue; // no id, nothing that could be claimed
    const status = text(campaign.claimStatus).trim().toUpperCase();
    const content = localizedContent(campaign);
    campaigns.push({
      id,
      key: text(campaign.campaignKey),
      actionType: text(campaign.actionType),
      status: CLAIM_STATUSES.has(status) ? (status as ClaimStatus) : "UNKNOWN",
      rawStatus: status,
      startAt: epochSeconds(campaign.startAt),
      endAt: epochSeconds(campaign.endAt),
      benefit: readBenefit(asRecord(campaign.benefit)),
      title: text(content.title),
      description: text(content.description),
      detailUrl: text(content.detailUrl),
    });
  }

  // A 200 with nothing in it is the normal shape of "this activity is not for
  // you right now". Callers must be able to say that without alarming anyone.
  const offline = !showCampaign || campaigns.length === 0;
  const reason = !showCampaign
    ? "hidden for this account"
    : campaigns.length === 0
      ? "list empty"
      : "";

  return {
    userID: text(body.uid ?? body.user_id ?? body.userId),
    showCampaign,
    claimable,
    campaigns,
    offline,
    reason,
  };
}

export function shapeClaimResult(payload: unknown): { status: string; amount: number | null } {
  const body = asRecord(payload) ?? {};
  return {
    status: text(body.status).trim().toUpperCase(),
    amount: finite(asRecord(body.reward)?.amount),
  };
}

// --- errors and the cooldown ladder ------------------------------------------

// A campaign failure carries meaning of its own: 409 is "you are outside the
// window", not "something broke". Folding every non-2xx into one string is what
// would turn a daily promo into a daily false alarm.
export class CampaignError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CampaignError";
    this.status = status;
  }
}

// Cooldown tiers.
//   GONE -- the route itself is missing. Six hours stops a daily cron nagging
//           for a dead activity while still picking up a campaign that comes
//           back next week with no intervention.
//   GAP  -- a transient 5xx/409: revisit inside the hour.
// There is deliberately NO cooldown for a 200 that simply had nothing to offer.
// `showCampaign` was observed flapping false while the daily window was still
// open, so sleeping on it would walk straight past the reward -- and a global
// marker would also silence every other account in an --all sweep.
const COOLDOWN_GONE_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_GAP_MS = 45 * 60 * 1000;

export function classifyStatus(status: number): {
  outcome: ClaimOutcome;
  message: string;
  cooldownMs: number;
} {
  switch (status) {
    case 401:
    case 403:
      return {
        outcome: "NOT_ELIGIBLE",
        message:
          "the campaign service did not accept this session (re-login, or check the account)",
        cooldownMs: 0,
      };
    case 404:
    case 410:
      return {
        outcome: "OFFLINE",
        message: "campaign endpoint is gone (activity withdrawn?)",
        cooldownMs: COOLDOWN_GONE_MS,
      };
    case 409:
      return {
        outcome: "WINDOW_CLOSED",
        message: "outside the campaign window, or this account is not eligible",
        cooldownMs: COOLDOWN_GAP_MS,
      };
    case 400:
      return { outcome: "ERROR", message: "the service rejected the campaign id", cooldownMs: 0 };
    case 502:
    case 503:
    case 504:
      return {
        outcome: "SERVICE_UNAVAILABLE",
        message: `campaign service unavailable (HTTP ${status})`,
        cooldownMs: COOLDOWN_GAP_MS,
      };
    default:
      return {
        outcome: "ERROR",
        message: `campaign service returned HTTP ${status}`,
        cooldownMs: COOLDOWN_GAP_MS,
      };
  }
}

// Any throw becomes a verdict. A non-HTTP failure is transient by default: the
// promo host is not the chat host, and a laptop asleep at noon should try again
// within the hour rather than be treated as a dead activity.
function toVerdict(error: unknown): {
  outcome: ClaimOutcome;
  message: string;
  cooldownMs: number;
} {
  if (error instanceof CampaignError) return classifyStatus(error.status);
  return {
    outcome: "SERVICE_UNAVAILABLE",
    message: `campaign request failed: ${errorMessage(error)}`,
    cooldownMs: COOLDOWN_GAP_MS,
  };
}

// --- local state -------------------------------------------------------------

// Advisory only, and cheap to lose. The server is the authority on what may be
// claimed; this file exists so a scheduled run does not re-POST a reward it already
// collected, and so a withdrawn endpoint is not probed every session. Deleting
// it costs one extra request and nothing else.
interface ClaimState {
  /** campaignId -> last local verdict, so a same-window repeat is skipped */
  claimed: Record<string, { endAt: number | null; at: number; awarded: number | null }>;
  /** epoch ms; requests are suppressed until this passes */
  cooldownUntil: number;
  /** consecutive "endpoint gone" verdicts, which drive the disable hint */
  goneStreak: number;
}

function emptyState(): ClaimState {
  return { claimed: {}, cooldownUntil: 0, goneStreak: 0 };
}

export function claimStateFile(region: QoderRegion = "global"): string {
  return opencodeConfigFile(stateFiles(region).claim);
}

function readState(region: QoderRegion = "global"): ClaimState {
  const raw = asRecord(readJsonFile("claim", claimStateFile(region)));
  if (!raw) return emptyState();
  const claimed: ClaimState["claimed"] = {};
  for (const [id, entry] of Object.entries(asRecord(raw.claimed) ?? {})) {
    const value = asRecord(entry);
    if (!value) continue;
    claimed[id] = {
      endAt: finite(value.endAt),
      at: finite(value.at) ?? 0,
      awarded: finite(value.awarded),
    };
  }
  const cooldownUntil = finite(raw.cooldownUntil) ?? 0;
  // A bad write or a clock skew must never lock the surface shut for good.
  if (cooldownUntil > Date.now() + COOLDOWN_GONE_MS * 4) {
    return { claimed, cooldownUntil: 0, goneStreak: 0 };
  }
  return {
    claimed,
    cooldownUntil,
    goneStreak: Math.max(0, finite(raw.goneStreak) ?? 0),
  };
}

function writeState(state: ClaimState, region: QoderRegion = "global"): void {
  writeJsonFile("claim", claimStateFile(region), state);
}

// Drop verdicts for windows that have already closed; without this the file
// grows by one line per campaign per day forever.
function prune(state: ClaimState, nowMs: number): ClaimState {
  const keep: ClaimState["claimed"] = {};
  for (const [id, entry] of Object.entries(state.claimed)) {
    if (entry.endAt === null || entry.endAt * 1000 > nowMs) keep[id] = entry;
  }
  return { ...state, claimed: keep };
}

export function resetClaimState(region: QoderRegion = "global"): boolean {
  try {
    writeState(emptyState(), region);
    return true;
  } catch (error) {
    logPlugin(`claim: state reset failed (${errorMessage(error)})`);
    return false;
  }
}

// --- transport ---------------------------------------------------------------

function campaignsUrl(region: QoderRegion): string {
  return resolveEndpoints(region).campaigns;
}

function claimUrl(region: QoderRegion, campaignId: string): string {
  return `${campaignsUrl(region)}/${encodeURIComponent(campaignId)}/claim`;
}

// Bearer-only, exactly like fetchQuotaUsage(): the COSY signature the chat
// endpoint needs is not part of this surface.
async function campaignRequest(
  options: QoderProviderOptions,
  url: string,
  method: "GET" | "POST",
  label: string,
): Promise<unknown> {
  const credentials = await resolveQoderCredentials(options);
  return fetchWithTimeout(
    url,
    { method, headers: jsonHeaders({ Authorization: `Bearer ${credentials.access}` }) },
    QODER_CLAIM_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        const detail = await readErrorBody(response, 160);
        throw new CampaignError(
          response.status,
          `${label}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`.trim(),
        );
      }
      const body = await response.text();
      if (!body) return {};
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`${label}: campaign service returned a non-JSON body`);
      }
    },
  );
}

// The email is already on the credential, so labelling an account costs no
// extra request; resolveQoderCredentials settles it from userinfo.
async function fetchCampaigns(
  options: QoderProviderOptions,
): Promise<{ list: CampaignList; account: string }> {
  const credentials = await resolveQoderCredentials(options);
  const payload = await campaignRequest(
    options,
    campaignsUrl(regionOf(options)),
    "GET",
    "campaign list",
  );
  return {
    list: shapeCampaignList(payload),
    account: accountLabel(credentials.email),
  };
}

async function postClaim(
  options: QoderProviderOptions,
  campaignId: string,
): Promise<{ status: string; amount: number | null }> {
  return shapeClaimResult(
    await campaignRequest(options, claimUrl(regionOf(options), campaignId), "POST", "claim"),
  );
}

// --- rendering ---------------------------------------------------------------

function accountLabel(email: string): string {
  return nonEmptyString(email) ?? "active account";
}

// Relative, not a local clock string: the cron host's timezone is not the
// reader's, and "opens in 3h24m" is the answer to the only question a daily
// promo actually raises.
export function formatWindow(campaign: Campaign, nowMs: number): string {
  if (campaign.startAt === null && campaign.endAt === null) return "window unknown";
  const span = (ms: number) => {
    const mins = Math.round(Math.abs(ms) / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, "0")}m`;
    return `${Math.floor(hours / 24)}d${hours % 24}h`;
  };
  const parts: string[] = [];
  if (campaign.startAt !== null) {
    const delta = campaign.startAt * 1000 - nowMs;
    parts.push(delta > 0 ? `opens in ${span(delta)}` : `open ${span(delta)}`);
  }
  if (campaign.endAt !== null) {
    const delta = campaign.endAt * 1000 - nowMs;
    parts.push(delta > 0 ? `closes in ${span(delta)}` : `closed ${span(delta)} ago`);
  }
  return parts.join(", ");
}

function campaignName(campaign: Campaign): string {
  return campaign.title || campaign.key || campaign.id;
}

function benefitLabel(campaign: Campaign): string {
  const benefit = campaign.benefit;
  if (!benefit) return "";
  const amount = benefit.amount === null ? "" : `${benefit.amount} `;
  const kind = benefit.kind ? benefit.kind.toLowerCase() : "reward";
  // The scope stays visible: "2000 credits, one model family only" is exactly
  // the detail a user needs before calling a promo grant a win.
  const scope = benefit.scope
    ? ` for ${benefit.scope.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase()}`
    : "";
  return `${amount}${kind}${scope}`;
}

function describeCampaign(campaign: Campaign, nowMs: number): string {
  const reward = benefitLabel(campaign);
  return `  ${campaignName(campaign)} [${campaign.status.toLowerCase()}]${
    reward ? ` ${reward}` : ""
  } -- ${formatWindow(campaign, nowMs)}`;
}

function disabledReport(): ClaimReport {
  return {
    output:
      `Campaign claims are switched off (${QODER_CLAIM_ENV}=off). Unset it to bring the ` +
      "tools and the /qoder-claim command back; nothing else in the plugin is affected.",
    data: { attempts: [], claimed: 0, cooldownUntil: null, disabled: true },
  };
}

function cooldownReport(state: ClaimState): ClaimReport {
  const until = new Date(state.cooldownUntil).toISOString().slice(0, 16);
  return {
    output: [
      `Campaign surface in cooldown until ${until} UTC -- no request was sent.`,
      state.goneStreak > 0
        ? `The campaign endpoint has answered "gone" ${state.goneStreak} run(s) running.`
        : "A previous campaign request failed at the service level.",
      "This only affects the promotional surface; the provider, models and chat are untouched.",
      `qoder_claim(reset=true) clears it, as does deleting ${claimStateFile()}.`,
    ].join("\n"),
    data: { attempts: [], claimed: 0, cooldownUntil: state.cooldownUntil, disabled: false },
  };
}

// --- the per-account sweep ---------------------------------------------------

interface AccountSweep {
  account: string;
  /** null when the request itself failed; then `error` carries the verdict. */
  list: CampaignList | null;
  attempts: CampaignAttempt[];
  error: { outcome: ClaimOutcome; message: string } | null;
  cooldownMs: number;
  gone: boolean;
}

// Which credentials to run against. Default is whatever the plugin would sign
// with; `all` walks the stored PATs so one scheduled run collects the reward on
// every account -- the whole reason the multi-PAT store exists.
function targets(options: QoderProviderOptions, all: boolean): QoderProviderOptions[] {
  if (!all) return [options];
  const pats = listPATs().filter((entry) => nonEmptyString(entry.pat));
  if (pats.length === 0) return [options];
  return pats.map((entry) => ({
    personalAccessToken: entry.pat,
    ...(entry.email ? { qoderEmail: entry.email } : {}),
  }));
}

// A campaign we collected ourselves, for the window currently on offer. Only an
// exact window match counts: when upstream omits endAt the local marker is too
// blunt to trust, so the request goes out and the SERVER decides -- it is the
// authority on once-a-day, and a duplicate POST is answered, not double-paid.
function locallyClaimed(state: ClaimState, campaign: Campaign): boolean {
  const entry = state.claimed[campaign.id];
  if (!entry || campaign.endAt === null) return false;
  return entry.endAt === campaign.endAt;
}

// A non-CLAIMABLE campaign still deserves a line: "already claimed" and "not
// eligible" are the two answers a user reading a daily log needs to see.
function describeExisting(account: string, campaign: Campaign, nowMs: number): CampaignAttempt {
  const window = formatWindow(campaign, nowMs);
  switch (campaign.status) {
    case "CLAIMED":
      return {
        account,
        outcome: "ALREADY_CLAIMED",
        message: `already claimed -- ${campaignName(campaign)} (${window})`,
        campaignId: campaign.id,
      };
    case "NOT_ELIGIBLE":
      return {
        account,
        outcome: "NOT_ELIGIBLE",
        message: `not eligible for ${campaignName(campaign)} (${window})`,
        campaignId: campaign.id,
      };
    case "BLOCKED":
      return {
        account,
        outcome: "NOT_ELIGIBLE",
        message: `${campaignName(campaign)} is blocked by the service (${window})`,
        campaignId: campaign.id,
      };
    case "REVOKED":
      return {
        account,
        outcome: "NOT_ELIGIBLE",
        message: `${campaignName(campaign)} was revoked (${window})`,
        campaignId: campaign.id,
      };
    default:
      return {
        account,
        outcome: "ERROR",
        message: `unrecognised campaign status "${campaign.rawStatus || "absent"}"`,
        campaignId: campaign.id,
      };
  }
}

async function attemptClaim(
  target: QoderProviderOptions,
  account: string,
  campaign: Campaign,
  nowMs: number,
  state: ClaimState,
): Promise<CampaignAttempt> {
  try {
    const result = await postClaim(target, campaign.id);
    if (result.status === "CLAIMED") {
      state.claimed[campaign.id] = {
        endAt: campaign.endAt,
        at: nowMs,
        awarded: result.amount,
      };
      const reward =
        result.amount !== null ? `+${result.amount} credits` : benefitLabel(campaign) || "reward";
      return {
        account,
        outcome: "CLAIMED",
        message: `claimed ${campaignName(campaign)}: ${reward}`,
        campaignId: campaign.id,
        awarded: result.amount,
      };
    }
    if (result.status === "BLOCKED") {
      return {
        account,
        outcome: "NOT_ELIGIBLE",
        message: `${campaignName(campaign)} became unclaimable between the list and the POST`,
        campaignId: campaign.id,
      };
    }
    if (result.status === "REVOKED") {
      return {
        account,
        outcome: "NOT_ELIGIBLE",
        message: `${campaignName(campaign)} is no longer valid`,
        campaignId: campaign.id,
      };
    }
    // An answer this module has not been taught. Say so, and point at the one
    // place that can settle whether anything was actually granted -- never
    // retry blind, because a POST is the mutation.
    return {
      account,
      outcome: "ERROR",
      message: `claim of ${campaignName(campaign)} answered "${
        result.status || "empty"
      }", which is not a known status. Check qoder_quota before trying again.`,
      campaignId: campaign.id,
    };
  } catch (error) {
    const verdict = toVerdict(error);
    return {
      account,
      outcome: verdict.outcome,
      message: verdict.message,
      campaignId: campaign.id,
    };
  }
}

async function sweep(
  options: QoderProviderOptions,
  all: boolean,
  nowMs: number,
  claim: boolean,
  state: ClaimState,
): Promise<AccountSweep[]> {
  const sweeps: AccountSweep[] = [];
  for (const target of targets(options, all)) {
    const label = accountLabel(text(target.qoderEmail));
    let result: { list: CampaignList; account: string };
    try {
      result = await fetchCampaigns(target);
    } catch (error) {
      const verdict = toVerdict(error);
      logPlugin(`claim: ${verdict.message}`);
      sweeps.push({
        account: label,
        list: null,
        attempts: [],
        error: { outcome: verdict.outcome, message: verdict.message },
        cooldownMs: verdict.cooldownMs,
        gone: verdict.outcome === "OFFLINE",
      });
      continue;
    }

    const account = result.account || label;
    const { list } = result;
    const attempts: CampaignAttempt[] = [];

    if (claim) {
      for (const campaign of list.campaigns) {
        if (campaign.status !== "CLAIMABLE") {
          attempts.push(describeExisting(account, campaign, nowMs));
          continue;
        }
        if (locallyClaimed(state, campaign)) {
          attempts.push({
            account,
            outcome: "SKIPPED_LOCAL",
            message: `${campaignName(campaign)} was claimed from this machine already; POST skipped`,
            campaignId: campaign.id,
          });
          continue;
        }
        attempts.push(await attemptClaim(target, account, campaign, nowMs, state));
      }
    }

    sweeps.push({ account, list, attempts, error: null, cooldownMs: 0, gone: false });
  }
  return sweeps;
}

function renderStatus(sweeps: AccountSweep[], nowMs: number, region: QoderRegion): string {
  const lines: string[] = ["Qoder campaign status (promotional surface, not the provider):"];
  for (const sweep of sweeps) {
    lines.push("", sweep.account);
    if (sweep.error) {
      lines.push(`  ${sweep.error.message}`);
      continue;
    }
    const list = sweep.list as CampaignList;
    if (list.offline) {
      lines.push(`  nothing on offer -- ${list.reason}`);
      continue;
    }
    const open = list.campaigns.filter((campaign) => campaign.status === "CLAIMABLE").length;
    lines.push(
      `  ${open} claimable now${
        list.campaigns.length === 1 ? "" : `, ${list.campaigns.length} campaigns listed`
      }`,
    );
    lines.push(...list.campaigns.map((campaign) => describeCampaign(campaign, nowMs)));
  }
  lines.push(
    "",
    `Read-only: no claim was made. qoder_claim() performs the daily POST for ${campaignsUrl(
      region,
    ).replace(/\/sash.*/, "")}.`,
  );
  return lines.join("\n");
}

function renderClaim(
  sweeps: AccountSweep[],
  nowMs: number,
  state: ClaimReport["data"] & { goneStreakHint?: string },
): string {
  const lines: string[] = [];
  for (const sweep of sweeps) {
    lines.push(sweep.account);
    if (sweep.error) {
      lines.push(`  ${sweep.error.message}`);
    } else if (sweep.attempts.length === 0) {
      const list = sweep.list as CampaignList;
      lines.push(
        `  nothing to claim -- ${
          list.offline ? list.reason : "no campaign is CLAIMABLE right now"
        }`,
      );
      for (const campaign of list.campaigns.slice(0, 3)) {
        lines.push(describeCampaign(campaign, nowMs));
      }
    } else {
      lines.push(...sweep.attempts.map(describeAttempt));
    }
    lines.push("");
  }
  const notes: string[] = [];
  if (state.claimed > 0) {
    notes.push(
      `${state.claimed} claim(s) landed. Credits renew through qoder_quota; ` +
        "the model picker refreshes on its own timer.",
    );
  }
  if (state.goneStreakHint) notes.push(state.goneStreakHint);
  return `${lines.join("\n").trimEnd()}${notes.length ? `\n\n${notes.join("\n")}` : ""}`;
}

function describeAttempt(attempt: CampaignAttempt): string {
  const marker: Record<ClaimOutcome, string> = {
    CLAIMED: "+",
    ALREADY_CLAIMED: "=",
    NOT_ELIGIBLE: "-",
    WINDOW_CLOSED: "-",
    SERVICE_UNAVAILABLE: "!",
    OFFLINE: "-",
    SKIPPED_LOCAL: "=",
    DISABLED: "-",
    ERROR: "!",
  };
  return `  ${marker[attempt.outcome]} ${attempt.message}`;
}

// --- public entry points -----------------------------------------------------

export async function reportCampaigns(
  options: QoderProviderOptions = {},
  { all = false }: { all?: boolean } = {},
): Promise<ClaimReport> {
  const nowMs = Date.now();
  if (claimDisabled()) return disabledReport();
  const state = readState(regionOf(options));
  if (state.cooldownUntil > nowMs) return cooldownReport(state);
  const sweeps = await sweep(options, all, nowMs, false, state);
  const attempts = sweeps.flatMap((sweep) => sweep.attempts);
  return {
    output: renderStatus(sweeps, nowMs, regionOf(options)),
    data: {
      attempts,
      claimed: 0,
      cooldownUntil: null,
      disabled: false,
    },
  };
}

export async function runClaim(
  options: QoderProviderOptions = {},
  { all = false, reset = false }: { all?: boolean; reset?: boolean } = {},
): Promise<ClaimReport> {
  const nowMs = Date.now();

  const region = regionOf(options);
  if (reset) {
    const cleared = resetClaimState(region);
    return {
      output: cleared
        ? `Cleared the campaign markers in ${claimStateFile(region)}. The next call asks the server again.`
        : `Could not rewrite ${claimStateFile(region)}; see the plugin log.`,
      data: { attempts: [], claimed: 0, cooldownUntil: null, disabled: false },
    };
  }
  if (claimDisabled()) return disabledReport();

  const state = readState(region);
  if (state.cooldownUntil > nowMs) return cooldownReport(state);

  const sweeps = await sweep(options, all, nowMs, true, state);
  const attempts = sweeps.flatMap((sweep) => sweep.attempts);
  const claimed = sweeps.reduce(
    (total, sweep) => total + sweep.attempts.filter((a) => a.outcome === "CLAIMED").length,
    0,
  );

  // Persist the cooldown ladder. Only a service-level failure extends it, and an
  // "endpoint gone" verdict on EVERY account is what counts as withdrawal --
  // one ineligible account must not cool the surface down for the others.
  const next = prune(state, nowMs);
  const cooldownMs = Math.max(0, ...sweeps.map((sweep) => sweep.cooldownMs));
  const allGone = sweeps.length > 0 && sweeps.every((sweep) => sweep.gone);
  next.cooldownUntil = cooldownMs > 0 ? nowMs + cooldownMs : 0;
  next.goneStreak = allGone ? state.goneStreak + 1 : 0;
  writeState(next, region);

  const goneStreakHint =
    next.goneStreak >= 3
      ? `The campaign endpoint has been gone for ${next.goneStreak} runs in a row. The activity looks ` +
        `finished: set ${QODER_CLAIM_ENV}=off to drop the tools and the /qoder-claim command, ` +
        "or remove the scheduled job."
      : "";

  return {
    output: renderClaim(sweeps, nowMs, {
      attempts,
      claimed,
      cooldownUntil: next.cooldownUntil || null,
      disabled: false,
      goneStreakHint,
    }),
    data: { attempts, claimed, cooldownUntil: next.cooldownUntil || null, disabled: false },
  };
}
