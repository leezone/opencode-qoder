import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";

// File primitives for the plugin's small JSON state files (PAT store, tier
// store, routing policy) and for locating opencode's own files. Each store
// used to hand-roll the same four things: the config path, a read that treats
// missing and corrupt as "start empty", a mkdir -p before writing, and pretty
// JSON. Folding them here means a location change or an atomicity fix lands on
// every store at once.

// opencode resolves every XDG base itself, identically on every platform:
//
//   config: XDG_CONFIG_HOME || ~/.config      data: XDG_DATA_HOME || ~/.local/share
//   cache:  XDG_CACHE_HOME || ~/.cache       state: XDG_STATE_HOME || ~/.local/state
//
// XDG is a freedesktop spec and Windows sets none of these variables, but
// opencode has no win32 branch either -- it keeps the same resolution there,
// so a Windows install really does use %USERPROFILE%\.config\opencode. The
// plugin must therefore mirror opencode rather than follow the platform's own
// convention: any file it writes has to be findable by the user's editor and
// the CLI without a second search path, and any file it reads (auth.json) is
// written by opencode under this exact rule. Node's path.join() and homedir()
// handle the separator and the home directory per platform, so nothing else
// about these paths needs a special case.
function xdgFile(envName: string, fallback: readonly string[], filename: string): string {
  return join(readEnv(envName) || join(homedir(), ...fallback), "opencode", filename);
}

// Config: state the user is expected to edit (routing policy, tier and PAT
// stores, the static model override).
export function opencodeConfigFile(filename: string): string {
  return xdgFile("XDG_CONFIG_HOME", [".config"], filename);
}

// Data: opencode's own state, read here where the plugin needs to see it
// (auth.json) or where it keeps an identifier beside the rest.
export function opencodeDataFile(filename: string): string {
  return xdgFile("XDG_DATA_HOME", [".local", "share"], filename);
}

// Cache: disposable, refetched on the next successful live fetch.
export function opencodeCacheFile(filename: string): string {
  return xdgFile("XDG_CACHE_HOME", [".cache"], filename);
}

// The data path as it looked before XDG_DATA_HOME was honoured: $HOME/.local/
// share/opencode. Only a reader needs this. A store written here while the
// variable was unset stays put when the variable is later exported, so a path
// that encodes identity (the machine id, which is a signing input) would
// otherwise be regenerated at the new location and silently change the
// fingerprint the server has already seen. Reads fall back to it; writes never
// do -- the new location is authoritative from the first write onward.
export function legacyOpencodeDataFile(filename: string): string {
  return join(join(homedir(), ".local", "share"), "opencode", filename);
}

// Parses the file, or returns undefined when it is missing, unreadable or
// invalid. A missing file is the normal fresh-install state and stays quiet;
// a corrupt one (usually a hand-edit typo) logs under `label`, because the
// caller is about to silently start from its empty default and that is the
// only trace of why an edit "did nothing".
export function readJsonFile(label: string, path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    logPlugin(`${label}: failed to read ${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

// mkdir -p + pretty JSON + owner-only mode. Returns whether the write landed;
// the caller logs its own success summary. The mkdir is inside the try on
// purpose: an unwritable directory must reach the caller as `false`, not as a
// throw.
//
// These files hold secrets (PAT store; tier and routing files ride the same
// writer). Without an explicit mode, writeFileSync lands at `0666 & ~umask` --
// 0644 on a typical Linux/macOS box, i.e. readable by every local user --
// whereas opencode keeps its own `auth.json` at 0600. So the mode is set after
// the write rather than via writeFileSync's `mode` option, which is only
// applied when the file is CREATED: an existing 0644 store would never be
// repaired on the next save.
//
// 0600 and not 0400 on purpose. On Windows there are no POSIX bits: libuv's
// chmod maps to SetFileAttributes and reads only the write bit, so 0400 would
// mark the file read-only and break every later save. 0600 keeps it writable
// and is a no-op for secrecy -- there `%USERPROFILE%`'s per-user ACL is what
// actually protects the file, which is also why the failure of chmod on
// filesystems without POSIX semantics (FAT32/exFAT, some CI runners) is
// swallowed instead of reported.
export function writeJsonFile(label: string, path: string, data: unknown): boolean {
  try {
    const dir = join(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // The payload landed; a filesystem that cannot express the mode is not a
      // write failure.
    }
    return true;
  } catch (error) {
    logPlugin(`${label}: failed to write ${path}: ${errorMessage(error)}`);
    return false;
  }
}
