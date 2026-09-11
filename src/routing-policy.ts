import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logPlugin } from "./log.js";

// Subagent routing policy: which model serves the plugin's pinned helper
// agents when the conversation runs on an above-default context tier.
//
// The tier, not the agent identity, drives the choice. A conversation on the
// default tier (200K) fits inside the free `lite` model, so pinned agents
// (plan/general/explore/title/compaction) run there at zero cost. A 400K/1M
// conversation does NOT fit in lite -- compaction has to read the whole
// conversation -- so those agents escalate to a cheap model that advertises
// the session's tier (default target: qfmodel / Qwen3.8-Flash at x0.1).
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

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  enabled: true,
  subagentModel: "lite",
  target: "qfmodel",
  threshold: 200_000,
  exemptAgents: ["title", "summary"],
};

interface Cache {
  policy: RoutingPolicy;
  mtimeMs: number;
  loadedAt: number;
}

function storePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configDir, "opencode", STORE_FILENAME);
}

function cached(): Cache | undefined {
  return (globalThis as Record<string, unknown>)[CACHE_KEY] as Cache | undefined;
}

function sanitize(raw: unknown): RoutingPolicy {
  const out: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY, exemptAgents: [...DEFAULT_ROUTING_POLICY.exemptAgents] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const data = raw as Record<string, unknown>;
  if (typeof data.enabled === "boolean") out.enabled = data.enabled;
  if (typeof data.subagentModel === "string" && data.subagentModel.trim() !== "")
    out.subagentModel = data.subagentModel.trim();
  if (typeof data.target === "string" && data.target.trim() !== "")
    out.target = data.target.trim();
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
  try {
    if (!existsSync(path)) return { policy: sanitize(null), mtimeMs: -1 };
    const mtimeMs = statSync(path).mtimeMs;
    const previous = cached();
    if (previous && previous.mtimeMs === mtimeMs) {
      return { policy: previous.policy, mtimeMs };
    }
    const policy = sanitize(JSON.parse(readFileSync(path, "utf8")));
    return { policy, mtimeMs };
  } catch (error) {
    logPlugin(`routing-policy: failed to read ${path}: ${error}`);
    return { policy: sanitize(null), mtimeMs: -1 };
  }
}

export function getRoutingPolicy(): RoutingPolicy {
  const { policy, mtimeMs } = readPolicyFile();
  setCachedPolicy(policy, mtimeMs);
  return policy;
}

function setCachedPolicy(policy: RoutingPolicy, mtimeMs: number): void {
  (globalThis as Record<string, unknown>)[CACHE_KEY] = {
    policy,
    mtimeMs,
    loadedAt: Date.now(),
  } satisfies Cache;
}

export function updateRoutingPolicy(patch: Partial<RoutingPolicy>): RoutingPolicy {
  const merged = sanitize({ ...getRoutingPolicy(), ...patch });
  const path = storePath();
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
    setCachedPolicy(merged, statSync(path).mtimeMs);
    logPlugin(
      `routing-policy: saved (enabled=${merged.enabled}, ${merged.subagentModel}->${merged.target} above ${merged.threshold})`,
    );
  } catch (error) {
    logPlugin(`routing-policy: failed to write ${path}: ${error}`);
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
