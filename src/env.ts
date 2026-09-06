// Leaf helper for reading environment variables.
//
// Deliberately its own module with no imports: constants.ts already depends on
// log.ts, so putting readEnv in constants.ts would make `log -> constants`
// circular, and log.ts is one of the call sites that needs it.

// Every Qoder env var is read the same way: absent and empty collapse to "",
// surrounding whitespace is not meaningful. The trim matters for logging -- a
// whitespace-only OPENCODE_QODER_LOG_FILE must disable logging, not open a file
// named " ".
export function readEnv(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}
