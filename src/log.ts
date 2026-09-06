import { appendFileSync } from "node:fs";

// Opt-in diagnostics. Point OPENCODE_QODER_LOG_FILE at a path and every line is
// appended there; leave it unset -- the default, and what a normal install runs
// with -- and logging is a no-op. Nothing reaches stderr or stdout either way,
// so `opencode run` output stays clean and the TUI is never polluted.
//
// Prefixed OPENCODE_QODER_ rather than QODER_ to avoid colliding with env vars
// that qodercli or the Qoder desktop app may already read.
//
// The variable is read on every call rather than cached at import time, so a
// long-lived server can be switched on without a restart, and tests can toggle
// it per case.
const LOG_FILE_ENV = "OPENCODE_QODER_LOG_FILE";

// Random per module instance. opencode loads this module more than once in the
// same process -- once for the legacy config hooks, once for the v2 catalog
// hooks -- and those instances do NOT share module state, which is invisible in
// a log that only carries a pid. Tagging every line makes it obvious which
// instance produced it.
const INSTANCE = Math.random().toString(36).slice(2, 8);

export function logPlugin(message: string): void {
  const file = String(process.env[LOG_FILE_ENV] ?? "").trim();
  if (file === "") return;
  try {
    appendFileSync(file, `${new Date().toISOString()} [opencode-qoder:${INSTANCE}] ${message}\n`);
  } catch {
    // An unwritable path must never break model discovery -- the same rule
    // saveDiskCache() follows. Deliberately silent: the only channel available
    // for reporting this is the one that just failed.
  }
}

// A logged cause is the only record most failures leave, and the unknown is
// typed as `unknown` everywhere a fetch or connection lookup can reject.
// Extracting the message by hand (`error instanceof Error ? error.message :
// String(error)`) was repeated at every catch site.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
