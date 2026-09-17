import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  QODER_KEY_FILE_DEFAULT,
  QODER_KEY_FILE_ENV,
  type QoderRegion,
  sharedKey,
} from "./constants.js";
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
//     config options, so a plain `~/.qoderkey_env` behaves exactly like the
//     old `{file:...}` option did. Nothing is written to the store.
//   * a list (`pt-a,pt-b`, one per line, or an `OPENCODE_QODER_PAT=...`
//     assignment) -- an IMPORT SOURCE. Seeds the pat-store on demand (the
//     store file is only created once something is actually imported), and the
//     store -- not this file -- then authenticates requests, exactly as if
//     OPENCODE_QODER_PAT had seeded it.
//
// The file can also be a shell-style env file (`export OPENCODE_QODER_PAT=...`).
// When that format is detected, the variable's value is extracted and used as
// the effective content -- so `~/.qoderkey_env` works out of the box.
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
// The configured PATH is shared (one option, one file); the parsed STATE and
// the mtime memory are per region, because a list-form file seeds each region's
// OWN pat-store and the two must not fight over one parsed result.
const PATH_KEY = "__opencode_qoder_key_file_path";
function stateKey(region: QoderRegion): string {
  return sharedKey("key_file_state", region);
}
function mtimesKey(region: QoderRegion): string {
  return sharedKey("key_file_mtimes", region);
}

// Recorded once from the provider/plugin options by the legacy config hook --
// the only realm that ever sees them.
export function setKeyFilePath(path: string): void {
  const trimmed = path.trim();
  if (trimmed) writeShared(PATH_KEY, trimmed);
}

// Resolution order: the configured option, then the env override, then
// ~/.qoderkey_env. "none" in any of them turns the layer off.
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

function rememberedMtimes(region: QoderRegion): Record<string, number> {
  return readShared<Record<string, number>>(mtimesKey(region)) ?? {};
}

function readState(region: QoderRegion): KeyFileState | undefined {
  return readShared<KeyFileState>(stateKey(region));
}

// Parse a shell-style env file and extract the value of a specific variable.
// Handles: export KEY="value", export KEY='value', export KEY=value, KEY="value", etc.
// Returns the value if found, otherwise undefined.
function extractEnvVar(content: string, varName: string): string | undefined {
  // Match: [export] VAR_NAME=["']value["'] or [export] VAR_NAME=value
  const pattern = new RegExp(
    `^(?:export\\s+)?${varName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`,
    "m",
  );
  const match = content.match(pattern);
  if (match) {
    // Return the first non-undefined capture group (double-quoted, single-quoted, or unquoted)
    return match[1] ?? match[2] ?? match[3];
  }
  return undefined;
}

// Re-reads and re-imports only when the file's mtime moved since the last
// check, so a steady-state process pays one statSync per call. Returns the
// current state; never throws.
export function refreshKeyFile(region: QoderRegion = "global"): KeyFileState {
  const path = keyFilePath();
  if (!path) {
    writeShared(stateKey(region), { path: "", kind: "disabled", token: "" });
    return readState(region) as KeyFileState;
  }

  const mtime = fileMtime(path);
  const previous = readState(region);
  if (previous && previous.path === path && rememberedMtimes(region)[path] === mtime) {
    return previous;
  }
  writeShared(mtimesKey(region), { ...rememberedMtimes(region), [path]: mtime });

  if (mtime === -1) {
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(stateKey(region), absent);
    return absent;
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    logPlugin(`key-file: cannot read ${path}: ${errorMessage(error)}`);
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(stateKey(region), absent);
    return absent;
  }

  // Try to extract env vars from shell-style env file first.
  // Priority: OPENCODE_QODER_PAT (list import) > QODER_PERSONAL_ACCESS_TOKEN (single credential)
  // If neither found, fall back to the whole file content (plain token file).
  const importValue = extractEnvVar(content, "OPENCODE_QODER_PAT");
  const singleValue = importValue
    ? undefined
    : extractEnvVar(content, "QODER_PERSONAL_ACCESS_TOKEN");
  const effectiveContent = importValue ?? singleValue ?? content;

  const shape = classifyImportValue(effectiveContent);
  if (shape.kind === "empty") {
    // An empty (or comment-only) file behaves like no file at all: no
    // credential, nothing to import, quiet -- the layers below it decide.
    const absent: KeyFileState = { path, kind: "absent", token: "" };
    writeShared(stateKey(region), absent);
    return absent;
  }
  if (shape.kind === "single") {
    const single: KeyFileState = { path, kind: "single", token: shape.token };
    writeShared(stateKey(region), single);
    logPlugin(
      `key-file: ${path} is a single credential (shape=${shape.pats.length ? "pat" : "opaque"})`,
    );
    return single;
  }

  const state: KeyFileState = { path, kind: shape.kind, token: "" };
  writeShared(stateKey(region), state);
  if (shape.kind === "list") {
    try {
      const result = importPATsFromValue(effectiveContent, region);
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
export function keyFileToken(region: QoderRegion = "global"): string {
  if (!readState(region)) refreshKeyFile(region);
  const state = readState(region);
  return state && state.kind === "single" ? state.token : "";
}

// For the qoder_auth layer table: a shape, never the content.
export function describeKeyFile(): string {
  const state = refreshKeyFile();
  if (state.kind === "single") return state.token.startsWith("pt-") ? "pat" : "opaque";
  return state.kind;
}
