import { statSync } from "node:fs";
import { opencodeConfigFile, readJsonFile, writeJsonFile } from "./json-store.js";
import { errorMessage, logPlugin } from "./log.js";
import { readShared, writeShared } from "./shared-state.js";

// Subagent routing policy: which model serves the plugin's pinned helper
// agents when the conversation runs on an above-default context tier.
//
// The tier, not the agent identity, drives the choice. A conversation on the
// default tier (200K) fits inside the free `lite` model, so pinned agents
// (plan/general/explore/title/compaction) run there at zero cost. A 400K/1M
// conversation does NOT fit in lite -- compaction has to read the whole
// conversation -- so those agents escalate to a cheap model that advertises
// the session's tier (default target: qfmodel, the cheapest model
// that advertises it -- its multiplier rides the live catalog).
//
// Customizable via ~/.config/opencode/qoder-routing.json; missing fields keep
// their defaults, unknown fields are ignored, and a broken file never blocks
// a request. The same globalThis-cache + mtime-reread pattern as tier-store so
// a policy set through the tool is instantly visible to the request realm.

const STORE_FILENAME = "qoder-routing.json";
const CACHE_KEY = "__opencode_qoder_routing_policy";

export interface RoutingPolicy {
  /** master switch; false keeps every request on its selected model */
  enabled: boolean;
  /** the pinned subagent model this policy escalates (this plugin's default) */
  subagentModel: string;
  /** where escalated requests go */
  target: string;
  /** escalate when the conversation tier exceeds this token count */
  threshold: number;
  /** agents that keep the subagent model even above the threshold */
  exemptAgents: string[];
}

// Which agents are exempt, and why:
//   - title is the ONLY one kept on the base model by default. It is driven
//     from a short prompt (the first user turn) regardless of how long the
//     conversation grows, it is free (lite), and it fires often -- escalating
//     it to a billed model would cost real money for nothing. A 1M conversation
//     that switches tiers still title-generates on lite at the default window,
//     which always fits; buildRequestBody drops the session tier from the wire
//     when the serving model does not advertise it.
//   - compaction receives the WHOLE conversation and MUST follow the tier:
//     exempting it is exactly what strands a >200k chat.
//   - task children (plan/general/explore) resolve to the conversation's tier
//     too. Their prompts start small, so they usually stay under the threshold
//     and ride lite free; a long-running child that grows past it escalates
//     like compaction. The user explicitly chose this ("subagent uses
//     flash@1M"); the cost only materialises for a genuinely large child.
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  enabled: true,
  subagentModel: "lite",
  target: "qfmodel",
  threshold: 200_000,
  exemptAgents: ["title"],
};

interface Cache {
  policy: RoutingPolicy;
  mtimeMs: number;
  loadedAt: number;
}

function storePath(): string {
  return opencodeConfigFile(STORE_FILENAME);
}

function cached(): Cache | undefined {
  return readShared<Cache>(CACHE_KEY);
}

function sanitize(raw: unknown): RoutingPolicy {
  const out: RoutingPolicy = {
    ...DEFAULT_ROUTING_POLICY,
    exemptAgents: [...DEFAULT_ROUTING_POLICY.exemptAgents],
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const data = raw as Record<string, unknown>;
  if (typeof data.enabled === "boolean") out.enabled = data.enabled;
  if (typeof data.subagentModel === "string" && data.subagentModel.trim() !== "")
    out.subagentModel = data.subagentModel.trim();
  if (typeof data.target === "string" && data.target.trim() !== "") out.target = data.target.trim();
  const threshold = Number(data.threshold);
  if (Number.isInteger(threshold) && threshold > 0) out.threshold = threshold;
  if (Array.isArray(data.exemptAgents)) {
    const agents = data.exemptAgents
      .filter((agent): agent is string => typeof agent === "string" && agent.trim() !== "")
      .map((agent) => agent.trim());
    out.exemptAgents = agents;
  }
  return out;
}

function readPolicyFile(): { policy: RoutingPolicy; mtimeMs: number } {
  const path = storePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    // Missing (the normal fresh state) or unreadable -- say so and default.
    logPlugin(`routing-policy: no readable policy at ${path} (${errorMessage(error)})`);
    return { policy: sanitize(null), mtimeMs: -1 };
  }
  const previous = cached();
  if (previous && previous.mtimeMs === mtimeMs) {
    return { policy: previous.policy, mtimeMs };
  }
  // A corrupt file logs once inside readJsonFile and answers undefined;
  // sanitize(null) keeps the defaults rather than blocking the request.
  return { policy: sanitize(readJsonFile("routing-policy", path) ?? null), mtimeMs };
}

export function getRoutingPolicy(): RoutingPolicy {
  const { policy, mtimeMs } = readPolicyFile();
  setCachedPolicy(policy, mtimeMs);
  return policy;
}

function setCachedPolicy(policy: RoutingPolicy, mtimeMs: number): void {
  writeShared(CACHE_KEY, {
    policy,
    mtimeMs,
    loadedAt: Date.now(),
  } satisfies Cache);
}

export function updateRoutingPolicy(patch: Partial<RoutingPolicy>): RoutingPolicy {
  const merged = sanitize({ ...getRoutingPolicy(), ...patch });
  const path = storePath();
  if (writeJsonFile("routing-policy", path, merged)) {
    try {
      setCachedPolicy(merged, statSync(path).mtimeMs);
    } catch {
      // The write landed; a stat race only costs one extra reread next call.
      setCachedPolicy(merged, -1);
    }
    logPlugin(
      `routing-policy: saved (enabled=${merged.enabled}, ${merged.subagentModel}->${merged.target} above ${merged.threshold})`,
    );
  }
  return merged;
}

// Decide the model that actually serves a request, given the conversation's
// session tier. Pure so the request path and the tests share one rule:
//
//   - policy off, or no session tier, or tier within the subagent model's own
//     window -> keep the selected model;
//   - agent exempt -> keep;
//   - otherwise -> escalate to the target, but only when the target actually
//     advertises the tier (validating here is what stops a 1M session from
//     being escalated onto a 400K-only model);
//   - the tier that rides the wire is returned alongside, already resolved.
export function resolveRouting(input: {
  policy: RoutingPolicy;
  modelID: string;
  agent: string;
  sessionTier: number | undefined;
  targetSupports: (modelID: string, tokens: number) => boolean;
}): { modelID: string; escalated: boolean } {
  const { policy, modelID, agent, sessionTier, targetSupports } = input;
  if (!policy.enabled || sessionTier === undefined || sessionTier <= policy.threshold) {
    return { modelID, escalated: false };
  }
  if (modelID !== policy.subagentModel) return { modelID, escalated: false };
  if (agent !== "" && policy.exemptAgents.includes(agent)) return { modelID, escalated: false };
  if (!targetSupports(policy.target, sessionTier)) return { modelID, escalated: false };
  return { modelID: policy.target, escalated: true };
}
