import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { opencodeConfigFile, readJsonFile, writeJsonFile } from "./json-store.js";
import { errorMessage, logPlugin } from "./log.js";
import { readShared, writeShared } from "./shared-state.js";

// Multi-PAT storage: lets users store several Qoder accounts and switch between
// them at runtime. The active PAT is used by resolveQoderCredentials() before
// falling back to environment variables.
//
// Storage location: ~/.config/opencode/qoder-pats.json (honours XDG_CONFIG_HOME)
//
// Each entry carries:
//   - id: stable identifier (truncated SHA-256 of the token, never the token)
//   - label: human-readable name (e.g. "Work Account", "Personal")
//   - pat: the raw Personal Access Token (pt-...)
//   - email: account email (fetched on add, for display)
//   - active: whether this is the currently selected PAT
//
// Only one entry can be active at a time. Switching sets active=true on the
// target and active=false on all others.

export interface StoredPAT {
  id: string;
  label: string;
  pat: string;
  email?: string;
  active: boolean;
  // True only when the user CHOSE this entry (qoder_pat_switch). Separates an
  // explicit pick from whatever addPAT auto-activated as a side effect, so
  // credential resolution can keep a passive single credential (the key file,
  // or the apiKey option) above the store and the user's deliberate choice
  // above that -- see the precedence table in auth.ts. Cleared by
  // followConfig() to hand control back to the configured credential.
  selected?: boolean;
}

interface PATStoreData {
  entries: StoredPAT[];
}

const STORE_FILENAME = "qoder-pats.json";

// Cache lives on globalThis, not module state: a PAT switched by a tool in one
// plugin instance must be visible to credential resolution in the other. The
// realm-boundary explanation lives once, in shared-state.ts.
//
// It also carries the file's mtime so an OUT-OF-BAND edit -- the standalone
// recovery script flipping `active`, or a hand edit -- is picked up by a
// running opencode without a restart. This is the credential that signs every
// request; when the active PAT is dead, restart-to-apply is exactly the friction
// the shell escape hatch is supposed to remove. Same mtime-reuse contract as
// routing-policy.ts.
const CACHE_KEY = "__opencode_qoder_pat_store";

interface Cache {
  data: PATStoreData;
  mtimeMs: number;
}

function cachedStore(): Cache | undefined {
  return readShared<Cache>(CACHE_KEY);
}

function setCachedStore(data: PATStoreData | undefined, mtimeMs: number): void {
  if (!data) {
    writeShared(CACHE_KEY, undefined);
    return;
  }
  writeShared(CACHE_KEY, { data, mtimeMs });
}

function storePath(): string {
  return opencodeConfigFile(STORE_FILENAME);
}

// Where the store lives, for a caller that has to name the file to the user --
// the auth-failure hint in language-model.ts points its shell recovery at this
// exact path so the two agree with the writer.
export function patStoreFile(): string {
  return storePath();
}

// File mtime, or -1 for a missing file (the normal fresh-install state, quiet)
// and for a stat that fails on an existing path (logged once). -1 doubles as
// the "no file" cache stamp so a create/delete is detected as a change.
function storeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logPlugin(`pat-store: cannot stat ${path}: ${errorMessage(error)}`);
    }
    return -1;
  }
}

// Re-reads only when the file's mtime moved since the last load, so an external
// `active` flip is honored on the next request while a steady-state process
// pays one statSync per read and no parse.
function loadStore(): PATStoreData {
  const path = storePath();
  const mtimeMs = storeMtime(path);
  const cached = cachedStore();
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  let data: PATStoreData = { entries: [] };
  if (mtimeMs !== -1) {
    const parsed = readJsonFile("pat-store", path);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as PATStoreData).entries)) {
      data = { entries: (parsed as PATStoreData).entries.filter(isValidEntry) };
    }
  }
  setCachedStore(data, mtimeMs);
  return data;
}

// Drop the in-memory copy so the next loadStore() re-reads the file. With
// mtime revalidation this is only needed when a caller wants to force a re-read
// without a file change; export kept for tests.
export function invalidateStore(): void {
  setCachedStore(undefined, -1);
}

function isValidEntry(value: unknown): value is StoredPAT {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.label === "string" &&
    typeof entry.pat === "string" &&
    typeof entry.active === "boolean" &&
    (entry.selected === undefined || typeof entry.selected === "boolean")
  );
}

function saveStore(): void {
  const cached = cachedStore();
  if (!cached) return;
  const path = storePath();
  if (writeJsonFile("pat-store", path, cached.data)) {
    // Re-stamp the cache with the new mtime: this write must not read back as
    // an out-of-band edit on the next load. A stat failure after a successful
    // write leaves the stale stamp, whose only cost is one extra re-parse.
    setCachedStore(cached.data, storeMtime(path));
    logPlugin(`pat-store: saved ${cached.data.entries.length} entries to ${path}`);
  }
}

// Generate a stable short ID from a PAT: a truncated SHA-256 of the whole
// token. The old scheme used the first 12 characters of the token itself,
// which replicated a slice of the secret into every place the ID is shown --
// tool output, error hints, the recovery script's table. A hash keeps the ID
// stable per token (the same PAT always resolves to the same handle) without
// being reversible. Entries stored under the old prefix-IDs keep working:
// addPAT dedupes by the raw token, not by this derivation.
function patID(pat: string): string {
  return `pat_${createHash("sha256").update(pat).digest("hex").slice(0, 12)}`;
}

// Returns all stored PATs (shape only, never the full token in logs).
export function listPATs(): StoredPAT[] {
  return loadStore().entries;
}

// Returns the currently active PAT, or undefined if none is active.
export function getActivePAT(): StoredPAT | undefined {
  return loadStore().entries.find((e) => e.active);
}

// Returns the raw PAT string of the active entry, or undefined.
export function getActivePatString(): string | undefined {
  const entry = getActivePAT();
  return entry?.pat;
}

// Add a new PAT to the store. If it is the first entry, it becomes active
// automatically. Returns the stored entry, or undefined if the PAT already
// exists (duplicate detection by the raw token, or by ID).
export function addPAT(pat: string, label: string, email?: string): StoredPAT | undefined {
  const store = loadStore();
  const id = patID(pat);

  // Duplicate check: the raw token is the durable identity (an ID re-derivation
  // must not turn a re-import into a second entry), the ID catches hand-edited
  // collisions.
  if (store.entries.some((e) => e.pat === pat || e.id === id)) {
    logPlugin(`pat-store: PAT ${id} already exists`);
    return undefined;
  }

  const isFirst = store.entries.length === 0;
  const entry: StoredPAT = {
    id,
    label: label || `Account ${store.entries.length + 1}`,
    pat,
    email,
    active: isFirst,
  };
  store.entries.push(entry);
  saveStore();
  logPlugin(`pat-store: added ${id} (${entry.label}), active=${entry.active}`);
  return entry;
}

// Remove a PAT by ID. If the removed entry was active, no other entry becomes
// active automatically (the user must switch explicitly). Returns true if the
// entry was found and removed.
export function removePAT(id: string): boolean {
  const store = loadStore();
  const index = store.entries.findIndex((e) => e.id === id);
  if (index === -1) return false;
  const removed = store.entries.splice(index, 1)[0];
  saveStore();
  logPlugin(`pat-store: removed ${id} (${removed.label})`);
  return true;
}

// Switch the active PAT to the entry with the given ID, marking it as the
// user's explicit choice. Sets active/selected=false on all other entries.
// Returns true if the ID was found and switched.
export function switchPAT(id: string): boolean {
  const store = loadStore();
  const target = store.entries.find((e) => e.id === id);
  if (!target) return false;

  for (const entry of store.entries) {
    entry.active = entry.id === id;
    entry.selected = entry.id === id;
  }
  saveStore();
  logPlugin(`pat-store: switched to ${id} (${target.label})`);
  return true;
}

// Returns the raw PAT string of the entry the user explicitly selected (and
// that is still active), or undefined when nobody has switched. This is what
// outranks a passive configured credential in the resolution chain; the
// auto-activated first import does NOT set it (see StoredPAT.selected).
export function getSelectedPatString(): string | undefined {
  const entry = loadStore().entries.find((e) => e.active && e.selected);
  return entry?.pat;
}

// Hand authentication back to the configured credential (key file / apiKey
// option) by clearing every explicit selection. The `active` flag is left
// alone: it still names the entry the store layer falls back to. Returns
// whether anything changed.
export function followConfig(): boolean {
  const store = loadStore();
  let changed = false;
  for (const entry of store.entries) {
    if (entry.selected) {
      entry.selected = false;
      changed = true;
    }
  }
  if (changed) {
    saveStore();
    logPlugin("pat-store: following the configured credential (selection cleared)");
  }
  return changed;
}
