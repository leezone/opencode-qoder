import { opencodeConfigFile, readJsonFile, writeJsonFile } from "./json-store.js";
import { logPlugin } from "./log.js";
import { readShared, writeShared } from "./shared-state.js";

// Multi-PAT storage: lets users store several Qoder accounts and switch between
// them at runtime. The active PAT is used by resolveQoderCredentials() before
// falling back to environment variables.
//
// Storage location: ~/.config/opencode/qoder-pats.json (honours XDG_CONFIG_HOME)
//
// Each entry carries:
//   - id: stable identifier (short hash of the PAT prefix)
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
}

interface PATStoreData {
  entries: StoredPAT[];
}

const STORE_FILENAME = "qoder-pats.json";

// Cache lives on globalThis, not module state: a PAT switched by a tool in one
// plugin instance must be visible to credential resolution in the other. The
// realm-boundary explanation lives once, in shared-state.ts.
const CACHE_KEY = "__opencode_qoder_pat_store";

function cachedStore(): PATStoreData | undefined {
  return readShared<PATStoreData>(CACHE_KEY);
}

function setCachedStore(data: PATStoreData | undefined): void {
  writeShared(CACHE_KEY, data);
}

function storePath(): string {
  return opencodeConfigFile(STORE_FILENAME);
}

// Loaded once per process (shared by both plugin instances via globalThis).
// All mutations write through to disk and refresh the cache; reads hit the
// cache. Use invalidateStore() after an out-of-band file edit.
function loadStore(): PATStoreData {
  const cached = cachedStore();
  if (cached) return cached;
  const path = storePath();
  let data: PATStoreData = { entries: [] };
  const parsed = readJsonFile("pat-store", path);
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as PATStoreData).entries)) {
    data = { entries: (parsed as PATStoreData).entries.filter(isValidEntry) };
  }
  setCachedStore(data);
  return data;
}

// Drop the in-memory copy so the next loadStore() re-reads the file. Exported
// for tests and for any future tool that edits the store out of band.
export function invalidateStore(): void {
  setCachedStore(undefined);
}

function isValidEntry(value: unknown): value is StoredPAT {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.label === "string" &&
    typeof entry.pat === "string" &&
    typeof entry.active === "boolean"
  );
}

function saveStore(): void {
  const data = cachedStore();
  if (!data) return;
  const path = storePath();
  if (writeJsonFile("pat-store", path, data)) {
    logPlugin(`pat-store: saved ${data.entries.length} entries to ${path}`);
  }
}

// Generate a stable short ID from a PAT. Uses the first 12 chars after "pt-"
// so the ID is recognizable but not the full token.
function patID(pat: string): string {
  const prefix = pat.startsWith("pt-") ? pat.slice(3, 15) : pat.slice(0, 12);
  return `pat_${prefix}`;
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
// exists (duplicate detection by ID).
export function addPAT(pat: string, label: string, email?: string): StoredPAT | undefined {
  const store = loadStore();
  const id = patID(pat);

  // Duplicate check.
  if (store.entries.some((e) => e.id === id)) {
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

// Switch the active PAT to the entry with the given ID. Sets active=false on
// all other entries. Returns true if the ID was found and switched.
export function switchPAT(id: string): boolean {
  const store = loadStore();
  const target = store.entries.find((e) => e.id === id);
  if (!target) return false;

  for (const entry of store.entries) {
    entry.active = entry.id === id;
  }
  saveStore();
  logPlugin(`pat-store: switched to ${id} (${target.label})`);
  return true;
}

// Update the label or email of an existing entry. Returns true if found.
export function updatePAT(id: string, updates: { label?: string; email?: string }): boolean {
  const store = loadStore();
  const target = store.entries.find((e) => e.id === id);
  if (!target) return false;
  if (updates.label !== undefined) target.label = updates.label;
  if (updates.email !== undefined) target.email = updates.email;
  saveStore();
  logPlugin(`pat-store: updated ${id}`);
  return true;
}
