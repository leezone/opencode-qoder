// Coercion helpers for reading untrusted values (env vars, store files,
// catalog entries, opencode's credential records) into strings.
//
// Deliberately a leaf with no imports, like env.ts, so any module can use it
// without creating a cycle.

// A string-or-nothing read: anything that is not a string collapses to "".
// Used by parsers and renderers that must not print "undefined".
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The "usable string" guard shared by option and globalThis reads: absent,
// non-string and empty-string all collapse to undefined. (metadataString in
// index.ts next to credentialToOptions deliberately keeps a weaker guard -- it
// returns "" as a real value -- so it is NOT folded in here.)
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Ids arrive from tools, headers and store files; the trim is what makes
// " cmodel " resolve to "cmodel". String() first so a non-string never throws
// and a nullish never becomes "undefined".
export function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}
