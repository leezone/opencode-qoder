import type { CapabilityReport } from "./capabilities.js";
import type { QoderRegion } from "./constants.js";
import { catalogModels, isValidContextTier } from "./model-catalog.js";
import { getRoutingPolicy, type RoutingPolicy, updateRoutingPolicy } from "./routing-policy.js";
import { resolveRootSession } from "./session-roots.js";
import {
  clearAllTiers,
  clearSessionTier,
  clearTier,
  getSessionTier,
  listSelectedTiers,
  setSessionTier,
  setTier,
} from "./tier-store.js";

// The context-tier + routing surface: qoder_tier_list, qoder_tier_switch and
// qoder_routing_policy, moved out of index.ts to follow the claim.ts /
// pat-tools.ts precedent -- a product surface's logic lives in its own module,
// and index.ts only adapts it to Hooks.tool. The store primitives stay in
// tier-store.ts / routing-policy.ts (pure state); THIS module owns what the
// tools SAY and in what order they apply it, which is policy, not state.
//
// `refresh` is injected rather than imported: only the v2 instance owns
// ctx.catalog.reload(), and the legacy instance reaches it through a globalThis
// trigger published by setupV2. That cross-realm plumbing stays in index.ts.

export function reportTierList(
  sessionID?: string,
  region: QoderRegion = "global",
): CapabilityReport {
  const selections = listSelectedTiers(region);
  const root = sessionID ? resolveRootSession(sessionID) : "";
  const sessionTier = root ? getSessionTier(root, region) : undefined;
  const tiers = catalogModels(region)
    .filter((model) => (model.contextTiers?.length ?? 0) > 0 || model.id in selections)
    .map((model) => ({
      model: model.id,
      defaultTier: model.contextWindow,
      availableTiers: model.contextTiers ?? [model.contextWindow],
      selected: selections[model.id] ?? null,
    }));
  const header =
    sessionTier !== undefined
      ? `This conversation runs at the ${sessionTier}-token tier (session ${root}).\n\n`
      : "This conversation runs at each model's default tier (no switch yet).\n\n";
  const output =
    header +
    (tiers.length === 0
      ? "No model advertises multiple context tiers. All run at their default tier."
      : tiers
          .map((entry) => {
            const selected = entry.selected ? ` [displayed: ${entry.selected}]` : " [default]";
            return `${entry.model}: ${entry.availableTiers.join(" / ")}${selected}`;
          })
          .join("\n") +
        "\n\nSwitch for THIS conversation with qoder_tier_switch(model, tier) -- or " +
        'model "*" to set every model that advertises the tier; subagent requests ' +
        "(compaction, task children) follow the same tier automatically.");
  return { output, data: { tiers, sessionTier: sessionTier ?? null } };
}

// Subagent caveat shared by both faces of qoder_tier_switch: above the pinned
// helper model's window the routing policy escalates compaction/task requests
// to a model that advertises the tier, so the whole exchange -- not just the
// main thread -- fits.
function routingNote(tier: number, region: QoderRegion): string {
  const policy = getRoutingPolicy(region);
  if (tier <= policy.threshold) return "";
  return policy.enabled
    ? `\n\nPinned subagents (compaction, task children) auto-escalate to ${policy.target} at this tier (policy: qoder_routing_policy).`
    : `\n\nWarning: routing is disabled, so the compaction agent stays on a ${policy.threshold}-token model and cannot compact this conversation above that. Re-enable with qoder_routing_policy, or override agent.compaction in opencode.json.`;
}

export function reportTierSwitch(
  args: { model: string; tier?: number },
  sessionID: string | undefined,
  region: QoderRegion = "global",
  refresh: (labelChanged?: boolean) => boolean = () => false,
): CapabilityReport {
  const root = sessionID ? resolveRootSession(sessionID) : "";
  if (args.model === "*") {
    // Bulk: the per-conversation session binding is a single number, so
    // only the display-mode map fans out; a skipped model keeps its own
    // advertised default rather than an unsupported ceiling.
    if (args.tier === undefined) {
      const clearedMode = clearAllTiers();
      const clearedSession = root ? clearSessionTier(root) : false;
      refresh(clearedMode);
      return {
        output:
          clearedMode || clearedSession
            ? "All tier selections cleared; every model is back on its advertised default."
            : "Nothing was selected, so nothing to clear.",
        data: { success: true, model: "*", cleared: clearedMode || clearedSession },
      };
    }
    const tier = args.tier;
    const matches = catalogModels(region).filter((model) => model.contextTiers?.includes(tier));
    if (matches.length === 0) {
      const offered = [
        ...new Set(
          catalogModels(region)
            .flatMap((model) => model.contextTiers ?? [])
            .sort((a, b) => a - b),
        ),
      ];
      return {
        output:
          `No advertised model offers a ${tier}-token tier. ` +
          `Tiers in use: ${offered.join(" / ")}. Run qoder_tier_list for the per-model table.`,
        data: { success: false, model: "*", tier },
      };
    }
    if (root) setSessionTier(root, tier, region);
    for (const model of matches) setTier(model.id, tier, region);
    const unsupported = catalogModels(region)
      .filter((model) => !model.contextTiers?.includes(tier))
      .map((model) => model.id);
    const refreshed = refresh(true);
    return {
      output:
        `Set the ${tier}-token tier on ${matches.length} model(s): ` +
        `${matches.map((model) => model.id).join(", ")}. ` +
        (root
          ? `This conversation now runs at that tier whichever of them it uses. `
          : `No conversation id yet, so only the picker labels were set. `) +
        (unsupported.length > 0
          ? `${unsupported.length} model(s) left unchanged (no such tier): ${unsupported.join(", ")}. `
          : "") +
        (refreshed
          ? "The picker labels and compaction limits are reloading now."
          : "Restart opencode to update the picker labels and limits.") +
        routingNote(tier, region),
      data: {
        success: true,
        model: "*",
        tier: args.tier,
        applied: matches.map((model) => model.id),
        session: root || null,
      },
    };
  }
  const def = catalogModels(region).find((model) => model.id === args.model);
  if (!def) {
    return {
      output: `Model "${args.model}" not found. Run qoder_models to list available models.`,
      data: { success: false },
    };
  }
  if (args.tier === undefined) {
    const clearedSession = root ? clearSessionTier(root, region) : false;
    const clearedMode = clearTier(args.model, region);
    refresh(clearedMode);
    return {
      output:
        clearedSession || clearedMode
          ? `This conversation returns to ${args.model}'s default tier (${def.contextWindow} tokens).`
          : `This conversation had no tier switch for ${args.model}; it already runs at the default.`,
      data: { success: true, cleared: clearedSession || clearedMode },
    };
  }
  if (!isValidContextTier(def, args.tier)) {
    const offered = def.contextTiers?.join(" / ") ?? `<= ${def.inputWindow ?? def.contextWindow}`;
    return {
      output:
        `Tier ${args.tier} is not valid for ${args.model}. ` +
        `Accepted values: ${offered}. Run qoder_tier_list for the full table.`,
      data: { success: false },
    };
  }
  // The session binding drives the wire; the mode drives the picker label
  // and the registered (compaction-threshold) limits. A missing root id
  // (no session yet) degrades to the global mode alone.
  if (root) setSessionTier(root, args.tier, region);
  setTier(args.model, args.tier, region);
  const refreshed = refresh(true);
  return {
    output:
      `This conversation now runs at the ${args.tier}-token tier on ${args.model} (was ${def.contextWindow}). ` +
      (refreshed
        ? "The picker label and compaction limits are reloading now."
        : "Restart opencode to update the picker label and limits.") +
      routingNote(args.tier, region),
    data: { success: true, model: args.model, tier: args.tier, session: root || null },
  };
}

// One-line rendering of the routing policy for the tool surface.
function describePolicy(policy: RoutingPolicy): string {
  if (!policy.enabled) return "disabled (subagents stay on their selected model)";
  return (
    `${policy.subagentModel} -> ${policy.target} above ${policy.threshold} tokens` +
    ` (exempt: ${policy.exemptAgents.join(", ") || "none"})`
  );
}

export function reportRoutingPolicy(
  args: {
    enabled?: boolean;
    subagentModel?: string;
    target?: string;
    threshold?: number;
    exemptAgents?: string[];
  },
  region: QoderRegion = "global",
): CapabilityReport {
  const patch: Partial<RoutingPolicy> = {};
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (args.subagentModel) patch.subagentModel = args.subagentModel;
  if (args.target) patch.target = args.target;
  if (args.threshold !== undefined) patch.threshold = args.threshold;
  if (args.exemptAgents) patch.exemptAgents = args.exemptAgents;
  const changed = Object.keys(patch).length > 0;
  const policy = changed ? updateRoutingPolicy(patch, region) : getRoutingPolicy(region);
  if (changed && args.target && !catalogModels(region).some((m) => m.id === args.target)) {
    return {
      output: `Target "${args.target}" is not a known model. Policy left as: ${describePolicy(policy)}.`,
      data: { success: false, policy },
    };
  }
  return {
    output: `${changed ? "Updated " : ""}routing policy: ${describePolicy(policy)}.`,
    data: { success: true, policy },
  };
}
