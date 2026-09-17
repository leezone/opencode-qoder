import { describeTokenShape } from "./auth.js";
import type { CapabilityReport } from "./capabilities.js";
import type { QoderRegion } from "./constants.js";
import { refreshKeyFile } from "./key-file.js";
import {
  addPAT,
  followConfig,
  getActivePAT,
  listPATs,
  removePAT,
  type StoredPAT,
  switchPAT,
} from "./pat-store.js";

// The PAT surface: the four qoder_pat_* tools' logic, kept out of index.ts the
// way claim.ts keeps the campaign surface -- one module owns one product
// surface, index.ts only adapts it to opencode's Hooks.tool shape. These tools
// MUTATE (add/remove/switch), which is exactly why they do not live in
// capabilities.ts: that module is the read-only account-info layer, and its
// header says so. The split is not decoration: a precedence bug in the store
// (the whole reason qoder_pat_switch exists) gets one place to look.
//
// The reports return plain strings, not Promises; the tool execute wrappers
// that need async wrap them at the index.ts boundary, so this module stays
// testable without the plugin runtime.

// A stored PAT with the token replaced by its shape. Tool results land in
// opencode's session storage, so `data` must carry the same redaction the
// human-readable `output` already had -- a raw entry there would replicate
// the plaintext token from the 0600 store into session storage. The report
// carries everything the output text shows, plus a token SHAPE -- the same
// "describe, never print" rule the log lines and qoder_auth follow.
function redactPAT(entry: StoredPAT): {
  id: string;
  label: string;
  email: string;
  active: boolean;
  selected: boolean;
  shape: string;
} {
  return {
    id: entry.id,
    label: entry.label,
    email: entry.email ?? "",
    active: entry.active,
    selected: entry.selected === true,
    shape: describeTokenShape(entry.pat),
  };
}

export function reportPatList(region: QoderRegion = "global"): CapabilityReport {
  // Refresh the seed key file first, so a file the user just edited shows
  // up in this answer rather than only after the next 60s tick.
  refreshKeyFile(region);
  const pats = listPATs(region);
  const active = getActivePAT(region);
  const output =
    pats.length === 0
      ? "No PATs stored yet. Seed them from the key file (default ~/.qoderkey_env, one " +
        "pt- token per line), the OPENCODE_QODER_PAT env var, or qoder_pat_add."
      : pats
          .map((p) => {
            const marker = p.active ? " [ACTIVE]" : "";
            const selected = p.selected ? " (explicitly selected)" : "";
            const email = p.email ? ` (${p.email})` : "";
            return `${p.id}: ${p.label}${email}${marker}${selected}`;
          })
          .join("\n");
  return { output, data: { accounts: pats.map(redactPAT), activeId: active?.id } };
}

export function reportPatSwitch(id?: string, region: QoderRegion = "global"): CapabilityReport {
  if (id === undefined) {
    const cleared = followConfig(region);
    return {
      output: cleared
        ? "Selection cleared. Requests now use the configured credential " +
          "(key file / apiKey option) as if no switch had happened."
        : "Nothing was explicitly selected, so requests already follow the configured credential.",
      data: { success: true, cleared },
    };
  }
  const success = switchPAT(id, region);
  const output = success
    ? `Switched to ${id}. This PAT signs all subsequent requests, overriding ` +
      `the configured credential until qoder_pat_switch is called without an id.`
    : `PAT ${id} not found. Run qoder_pat_list to see available accounts.`;
  return { output, data: { success, id } };
}

export function reportPatAdd(
  pat: string,
  label: string,
  email?: string,
  region: QoderRegion = "global",
): CapabilityReport {
  const entry = addPAT(pat, label, email, region);
  const output = entry
    ? `Added ${entry.id} (${entry.label}). ${entry.active ? "This is now the active PAT." : "Use qoder_pat_switch to activate it."}`
    : `PAT already exists (duplicate detected).`;
  return { output, data: { entry: entry ? redactPAT(entry) : null } };
}

export function reportPatRemove(id: string, region: QoderRegion = "global"): CapabilityReport {
  const success = removePAT(id, region);
  const output = success ? `Removed ${id}.` : `PAT ${id} not found.`;
  return { output, data: { success, id } };
}
