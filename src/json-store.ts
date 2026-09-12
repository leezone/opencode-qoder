import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";

// File primitives for the plugin's small JSON state files (PAT store, tier
// store, routing policy). Each one used to hand-roll the same four things:
// the XDG config path, a read that treats missing and corrupt as "start
// empty", a mkdir -p before writing, and pretty JSON. Folding them here means
// a location change or an atomicity fix lands on every store at once.

// The directory every plugin-side state file lives in, next to opencode's own
// config. `label` is the module prefix carried into log lines; the failure is
// reported once here rather than re-typed per store.
export function opencodeConfigFile(filename: string): string {
  const configDir = readEnv("XDG_CONFIG_HOME") || join(homedir(), ".config");
  return join(configDir, "opencode", filename);
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

// mkdir -p + pretty JSON. Returns whether the write landed; the caller logs
// its own success summary. The mkdir is inside the try on purpose: an
// unwritable directory must reach the caller as `false`, not as a throw.
export function writeJsonFile(label: string, path: string, data: unknown): boolean {
  try {
    const dir = join(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    logPlugin(`${label}: failed to write ${path}: ${errorMessage(error)}`);
    return false;
  }
}
