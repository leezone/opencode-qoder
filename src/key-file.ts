import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QODER_KEY_FILE_DEFAULT, QODER_KEY_FILE_ENV } from "./constants.js";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";
import { classifyImportValue, importPATsFromValue } from "./pat-import.js";
import { readShared, writeShared } from "./shared-state.js";

// The seed key file: the plugin-owned replacement for opencode's `{file:...}`
// apiKey option.
//
// opencode substitutes `{file:PATH}` BEFORE the plugin ever sees it, which is
// why the option spelled a location the plugin could not reuse: only the
// resolved content arrived, and an absolute path in config is not portable.
// This module keeps that logic on the plugin side instead: it resolves the
// file itself (homedir-relative by default, so it follows the user, not the
// machine), reads it, and decides what the content MEANS.
//
// The grammar decides the role (classifyImportValue in pat-import.ts):
//
//   * a bare single token (any shape) -- a CREDENTIAL. Resolution uses it
//     above the store's auto-active entry and below an explicit switch and the
//     config options, so a plain `~/.qoderkey_pat` behaves exactly like the
//     old `{file:...}` option did. Nothing is written to the store.
//   * a list (`pt-a,pt-b`, one per line, or an `OPENCODE_QODER_PAT=...`
//     assignment) -- an IMPORT SOURCE. Seeds the pat-store on demand (the
//     store file is only created once something is actually imported), and the
//     store -- not this file -- then authenticates requests, exactly as if
//     OPENCODE_QODER_PAT had seeded it.
//
// And unlike the env variable, which is read once at process startup, the file
// is LIVE: every refresh tick (and every qoder_pat_list call) pays one
// statSync; only when the mtime moved does it re-read, re-classify and
// re-import (addPAT dedupes, so repeats are free). Editing the file is the
// whole interface -- add a line, it joins the account table; no restart.
//
// "none" (option or env) disables the layer entirely.

export interface KeyFileState {
  path: string;
  kind: "disabled" | "absent" | "single" | "list";
  // The credential when kind === "single", otherwise "".
  token: string;
}

// Both caches ride on globalThis (shared-state.ts): opencode loads the plugin
// twice per process and the instance that checks on its timer is not the one
// resolving credentials for a request.
const PATH_KEY = "__opencode_qoder_key_file_path";
const STATE_KEY = "__opencode_qoder_key_file_state";
const MTIMES_KEY = "__opencode_qoder_key_file_mtimes";

// Recorded once from the provider/plugin options by the legacy config hook --
// the only realm that ever sees them.
export function setKeyFilePath(path: string): void {
  const trimmed = path.trim();
  if (trimmed) writeShared(PATH_KEY, trimmed);
}

// Resolution order: the configured option, then the env override, then
// ~/.qoderkey_pat. "none" in any of them turns the layer off.
export function keyFilePath(): string {
  const configured = readShared<string>(PATH_KEY) || readEnv(QODER_KEY_FILE_ENV);
  if (configured && configured.trim().toLowerCase() === "none") return "";
  return configured || join(homedir(), QODER_KEY_FILE_DEFAULT);
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    // A missing default file is the normal no-config state and stays quiet;
    // anything else is a real problem worth one line.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logPlugin(`key-file: cannot stat ${path}: ${errorMessage(error)}`);
    }
    return -1;
  }
}

function rememberedMtimes(): Record<string, number> {
  return readShared<Record<string, number>>(MTIMES_KEY) ?? {};
}

function readState(): KeyFileState | undefined {
  return readShared<KeyFileState>(STATE_KEY);
}

// Re-reads and re-imports only when the file's mtime moved since the last
// check, so a steady-state process pays one statSync per call. Returns the
// current state; never throws.
export function refreshKeyFile(): KeyFileState {
  const path = keyFilePath();
  if (!path) {
    writeShared(STATE_KEY, { path: "", kind: "disabled", token: "" });
    return readState() as KeyFileState;
  }

  const mtime = fileMtime(path);
  const previous = readState();
  if (previous && previous.path === path && rememberedMtimes()[path] === mtime) {
    return previous;
  }
  writeShared(MTIMES_KEY, { ...rememberedMtimes(), [path]: mtime });

  if (mtime === -1) {
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(STATE_KEY, absent);
    return absent;
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    logPlugin(`key-file: cannot read ${path}: ${errorMessage(error)}`);
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(STATE_KEY, absent);
    return absent;
  }

  const shape = classifyImportValue(content);
  if (shape.kind === "empty") {
    // An empty (or comment-only) file behaves like no file at all: no
    // credential, nothing to import, quiet -- the layers below it decide.
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(STATE_KEY, absent);
    return absent;
  }
  if (shape.kind === "single") {
    const single: KeyFileState = { path, kind: "single", token: shape.token };
    writeShared(STATE_KEY, single);
    logPlugin(
      `key-file: ${path} is a single credential (shape=${shape.pats.length ? "pat" : "opaque"})`,
    );
    return single;
  }

  const state: KeyFileState = { path, kind: shape.kind, token: "" };
  writeShared(STATE_KEY, state);
  if (shape.kind === "list") {
    try {
      const result = importPATsFromValue(content);
      logPlugin(
        `key-file: ${path} holds a PAT list -- imported ${result.imported}, ` +
          `skipped ${result.duplicates} already stored` +
          (result.invalid ? `, dropped ${result.invalid} non-pt- segment(s)` : "") +
          ". The pat-store now authenticates requests; switch with qoder_pat_switch.",
      );
    } catch (error) {
      logPlugin(`key-file: import from ${path} failed: ${errorMessage(error)}`);
    }
  }
  return state;
}

// The credential this file contributes to resolution: the token when it is a
// single-key file, "" when it is a list (the store took over), absent or
// disabled. The hot path is a pure cache read -- the disk is only touched for
// LAZY INITIALIZATION, when this process has never checked the file at all.
// (In opencode the startup hooks make that impossible; a bare script using
// the plugin's modules directly is the case this covers, and one stat there
// is cheaper than a credential silently going missing.)
export function keyFileToken(): string {
  if (!readState()) refreshKeyFile();
  const state = readState();
  return state && state.kind === "single" ? state.token : "";
}

// For the qoder_auth layer table: a shape, never the content.
export function describeKeyFile(): string {
  const state = refreshKeyFile();
  if (state.kind === "single") return state.token.startsWith("pt-") ? "pat" : "opaque";
  return state.kind;
}
