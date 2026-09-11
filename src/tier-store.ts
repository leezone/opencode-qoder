import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logPlugin } from "./log.js";

// Context-tier state, in two scopes:
//
// 1. SESSION TIERS -- the tier a live conversation actually runs at. Keyed by
//    the ROOT opencode session id, because that is the unit the user thinks of
//    ("this chat needs 1M"). Subagent requests carry their own (child) session
//    id; the caller resolves it upward through session-roots before looking
//    here, so a 1M conversation's compaction/task children see the same tier.
//    A new session has no entry and therefore runs at the model's DEFAULT
//    tier -- "new conversations start at 200K" needs no reset logic.
//
// 2. DISPLAY MODE -- the tier a model is currently showcased at. Drives the
//    picker annotation ("Qwen3.8-Max (1M)") and the registered limits
//    (modelLimit() in index.ts), which are process-global by nature: opencode
//    registers one catalog, not one per session. Cleared when a new root
//    session is created so the list falls back to default-tier labels.
//
// The chat request carries the session tier as parameters.context_length --
// the same field qodercli sends when the user picks a window there. Absent,
// the gateway applies the model's DEFAULT tier.
//
// State persists to ~/.config/opencode/qoder-tiers.json (honours
// XDG_CONFIG_HOME). Like pat-store, the in-memory copy lives on globalThis:
// opencode loads this plugin twice per process (legacy config hooks + v2
// catalog hooks) and module state is invisible across instances -- a tier
// switched by a tool in one instance must be visible to request building in
// the other. Same realm, so globalThis is the established channel.

const STORE_FILENAME = "qoder-tiers.json";
const CACHE_KEY = "__opencode_qoder_tier_store";

// Session entries untouched for this long are dropped at the next load. The
// map would otherwise grow with every chat ever started; the TTL is generous
// enough that no plausible conversation outlives it.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TierStoreData {
  /** model id -> tier in tokens currently shown in the picker / limits */
  mode: Record<string, number>;
  /** root session id -> tier in tokens that conversation runs at */
  sessions: Record<string, { tokens: number; at: number }>;
}

function emptyStore(): TierStoreData {
  return { mode: {}, sessions: {} };
}

function cachedStore(): TierStoreData | undefined {
  return (globalThis as Record<string, unknown>)[CACHE_KEY] as TierStoreData | undefined;
}

function setCachedStore(data: TierStoreData): void {
  (globalThis as Record<string, unknown>)[CACHE_KEY] = data;
}

function storePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configDir, "opencode", STORE_FILENAME);
}

function readTokens(value: unknown): number | undefined {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

function loadStore(): TierStoreData {
  const cached = cachedStore();
  if (cached) return cached;
  const path = storePath();
  let data = emptyStore();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      // `selections` is the v1 name for what is now `mode`; honour it so a
      // hand-edited or pre-v2 file keeps working as a global default.
      const mode = parsed.mode ?? parsed.selections;
      if (mode && typeof mode === "object" && !Array.isArray(mode)) {
        for (const [model, tokens] of Object.entries(mode)) {
          const count = readTokens(tokens);
          if (model !== "" && count) data.mode[model] = count;
        }
      }
      const sessions = parsed.sessions;
      if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
        const now = Date.now();
        let dropped = 0;
        for (const [session, entry] of Object.entries(sessions)) {
          const tokens = readTokens(
            entry && typeof entry === "object"
              ? (entry as Record<string, unknown>).tokens
              : entry,
          );
          const at =
            entry && typeof entry === "object"
              ? Number((entry as Record<string, unknown>).at)
              : // A bare-number entry is a hand-edited one; treat it as fresh
                // rather than dating it to the epoch (which would expire it).
                now;
          if (!session || !tokens || !Number.isFinite(at)) {
            dropped += 1;
            continue;
          }
          if (now - at >= SESSION_TTL_MS) {
            dropped += 1;
            continue;
          }
          data.sessions[session] = { tokens, at };
        }
        // Expired/invalid entries are dropped from memory by every realm alike;
        // without this rewrite each realm keeps re-loading (and re-dropping)
        // them forever, and the file never converges to what is actually live.
        if (dropped > 0) {
          setCachedStore(data);
          saveStore(data);
        }
      }
    } catch (error) {
      logPlugin(`tier-store: failed to read ${path}: ${error}`);
    }
  }
  setCachedStore(data);
  return data;
}

function saveStore(data: TierStoreData): void {
  const path = storePath();
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    logPlugin(
      `tier-store: saved ${Object.keys(data.mode).length} mode + ${Object.keys(data.sessions).length} session entr(y/ies) to ${path}`,
    );
  } catch (error) {
    logPlugin(`tier-store: failed to write ${path}: ${error}`);
  }
}

// --- Display mode ----------------------------------------------------------

// The tier a model is displayed/registered at, or undefined at default. Note
// this is deliberately NOT the request-path source any more -- requests ask
// getSessionTier() for the session's own choice first.
export function getSelectedTier(modelID: string): number | undefined {
  const id = String(modelID ?? "").trim();
  if (id === "") return undefined;
  return loadStore().mode[id];
}

export function listSelectedTiers(): Record<string, number> {
  return { ...loadStore().mode };
}

export function setTier(modelID: string, tokens: number): boolean {
  const id = String(modelID ?? "").trim();
  if (id === "" || !Number.isInteger(tokens) || tokens <= 0) return false;
  const data = loadStore();
  data.mode[id] = tokens;
  setCachedStore(data);
  saveStore(data);
  logPlugin(`tier-store: mode ${id} -> ${tokens}`);
  return true;
}

export function clearTier(modelID: string): boolean {
  const id = String(modelID ?? "").trim();
  if (id === "") return false;
  const data = loadStore();
  if (!(id in data.mode)) return false;
  delete data.mode[id];
  setCachedStore(data);
  saveStore(data);
  logPlugin(`tier-store: mode ${id} -> default`);
  return true;
}

// Drop every display-mode entry -- called when a NEW root session starts so
// the picker shows default tiers again ("new conversations default to 200K").
// Returns true when something was actually cleared (caller may skip a reload).
export function clearAllTiers(): boolean {
  const data = loadStore();
  if (Object.keys(data.mode).length === 0) return false;
  data.mode = {};
  setCachedStore(data);
  saveStore(data);
  logPlugin("tier-store: display mode reset to defaults (new session)");
  return true;
}

// --- Session tiers ---------------------------------------------------------

// The tier this conversation runs at, by ROOT session id; undefined means the
// session never switched and rides the model's default tier. Touching an entry
// refreshes its TTL timestamp (and persists when it changed in memory).
export function getSessionTier(sessionID: string): number | undefined {
  const id = String(sessionID ?? "").trim();
  if (id === "") return undefined;
  const data = loadStore();
  const entry = data.sessions[id];
  if (!entry) return undefined;
  if (Date.now() - entry.at >= SESSION_TTL_MS) {
    delete data.sessions[id];
    setCachedStore(data);
    saveStore(data);
    return undefined;
  }
  return entry.tokens;
}

export function setSessionTier(sessionID: string, tokens: number): boolean {
  const id = String(sessionID ?? "").trim();
  if (id === "" || !Number.isInteger(tokens) || tokens <= 0) return false;
  const data = loadStore();
  data.sessions[id] = { tokens, at: Date.now() };
  setCachedStore(data);
  saveStore(data);
  logPlugin(`tier-store: session ${id} -> context_length ${tokens}`);
  return true;
}

export function clearSessionTier(sessionID: string): boolean {
  const id = String(sessionID ?? "").trim();
  if (id === "") return false;
  const data = loadStore();
  if (!(id in data.sessions)) return false;
  delete data.sessions[id];
  setCachedStore(data);
  saveStore(data);
  logPlugin(`tier-store: session ${id} -> default tier`);
  return true;
}

// All live session tiers (root session id -> tokens), for the listing tools.
export function listSessionTiers(): Record<string, number> {
  const data = loadStore();
  const out: Record<string, number> = {};
  for (const [session, entry] of Object.entries(data.sessions)) out[session] = entry.tokens;
  return out;
}
