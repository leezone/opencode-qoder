import { QODER_PAT_IMPORT_ENV, type QoderRegion } from "./constants.js";
import { errorMessage, logPlugin } from "./log.js";
import { addPAT, listPATs } from "./pat-store.js";

// Multi-PAT bootstrap import from OPENCODE_QODER_PAT and from the seed key
// file.
//
// This is the intake side of the multi-account story. The durable, switchable
// home for several PATs is the pat-store (qoder-pats.json, one `active` flag);
// this module exists only to SEED that store -- from the environment, or (via
// key-file.ts) from a file the user can edit at any time -- so a fresh box or
// CI runner can be provisioned with `OPENCODE_QODER_PAT=pt-a,pt-b` and need no
// interactive /connect or qoder_pat_add. After the seed the source is
// redundant -- the store, not the variable or the file, is what auth later
// requests.
//
// Precedence is untouched: OPENCODE_QODER_PAT is NOT a credential-resolution
// layer (see constants.ts). It is consumed here and nowhere else. Importing is
// idempotent (addPAT dedupes by the raw token), so re-running it with the same
// value is a no-op.
//
// We deliberately require the `pt-` prefix for store-bound segments. The
// resolution chain treats a non-pt- token as an already-exchanged job token
// and passes it through; the store is for long-lived PATs, so a raw job token
// must not be persisted as if it were one. In a multi-segment value, non-pt-
// segments are dropped (counted, never logged); a lone non-pt- segment is a
// passthrough credential (see classifyImportValue's "single" kind), not junk.

export interface ImportResult {
  imported: number;
  duplicates: number;
  invalid: number;
}

// Comma is the documented primary (a bare value needs no shell quoting);
// semicolon is accepted for PATH-style muscle memory and newline for the file
// form (one PAT per line). Surrounding whitespace around each segment is
// trimmed away; a leading-# line is a comment and neither a PAT nor invalid.
const SEGMENT_SPLIT = /[;,\r\n]/;
const PAT_SHAPE = /^pt-/;

// Shell-sourcing grammar for a seed file: `OPENCODE_QODER_PAT=...` (optionally
// `export `, optionally quoted). Stripped before parsing so a file that
// doubles as a shell snippet still seeds the store, and so the assignment form
// is an unambiguous import marker even for a single token.
const ASSIGNMENT = /^(?:export\s+)?OPENCODE_QODER_PAT\s*=\s*/;

function stripAssignment(value: string): { body: string; assigned: boolean } {
  const trimmed = value.trim();
  const matched = ASSIGNMENT.test(trimmed);
  let body = matched ? trimmed.replace(ASSIGNMENT, "").trim() : trimmed;
  if (matched && body.length > 1) {
    const quote = body[0];
    if ((quote === '"' || quote === "'") && body.endsWith(quote)) {
      body = body.slice(1, -1);
    }
  }
  return { body, assigned: matched };
}

function segmentsOf(value: string): string[] {
  return value
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && !segment.startsWith("#"));
}

// The whole grammar in one place, shared by the env importer, the file importer
// (key-file.ts) and the credential layers that must tell a single token from a
// list. A lone non-pt- segment under "single" is the passthrough job token, so
// it yields no store-bound PATs but is still the credential.
export type ImportShape = {
  kind: "empty" | "single" | "list";
  token: string;
  pats: string[];
  invalid: number;
};

export function classifyImportValue(value: string): ImportShape {
  const { body, assigned } = stripAssignment(value);
  const segments = segmentsOf(body);
  if (segments.length === 0) return { kind: "empty", token: "", pats: [], invalid: 0 };
  if (!assigned && segments.length === 1) {
    const only = segments[0];
    const isPat = PAT_SHAPE.test(only);
    return { kind: "single", token: only, pats: isPat ? [only] : [], invalid: isPat ? 0 : 1 };
  }
  const pats = segments.filter((segment) => PAT_SHAPE.test(segment));
  return { kind: "list", token: "", pats, invalid: segments.length - pats.length };
}

// True when a value is a seed LIST rather than one credential. The credential
// layers skip these: an opencode `{file:...}` option or shared apiKey that
// resolves to a multi-token file is the user feeding the importer, not a
// bearer token, and sending it as one would only buy a 401.
export function isImportListValue(value: string): boolean {
  return classifyImportValue(value).kind === "list";
}

// The env-variable face of the grammar: split a value and hand back only the
// store-bound `pt-` segments plus a count of what was dropped.
export function parseImportValue(value: string): { pats: string[]; invalid: number } {
  const shape = classifyImportValue(value);
  return { pats: shape.pats, invalid: shape.invalid };
}

// Add every pt- segment of a value to the store. Shared by the env importer
// and the key-file importer; the VALUES never reach the log -- counts only.
export function importPATsFromValue(value: string, region: QoderRegion = "global"): ImportResult {
  const result: ImportResult = { imported: 0, duplicates: 0, invalid: 0 };
  const shape = classifyImportValue(value);
  result.invalid = shape.invalid;
  if (shape.pats.length === 0) return result;
  const before = listPATs(region).length;
  for (const [offset, pat] of shape.pats.entries()) {
    const label = `Imported ${before + offset + 1}`;
    const entry = addPAT(pat, label, undefined, region);
    if (entry) result.imported += 1;
    else result.duplicates += 1;
  }
  return result;
}

// Reads OPENCODE_QODER_PAT and imports every valid, not-already-stored PAT.
// Returns counts for the caller's log. Never throws: a broken store write is
// already swallowed inside addPAT/saveStore, and a malformed value is simply
// counted invalid.
export function importPATsFromEnv(
  region: QoderRegion = "global",
  env: NodeJS.ProcessEnv = process.env,
): ImportResult {
  const raw = env[QODER_PAT_IMPORT_ENV];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { imported: 0, duplicates: 0, invalid: 0 };
  return importPATsFromValue(value, region);
}

// The once-per-process startup call. Runs before discovery so a freshly seeded
// store can authenticate the very first catalog refresh. Logs only when it
// actually changed something or dropped something, so a steady-state process
// (variable unset, or every PAT already stored) stays quiet.
export function maybeImportPATsFromEnv(region: QoderRegion = "global"): void {
  let result: ImportResult;
  try {
    result = importPATsFromEnv(region);
  } catch (error) {
    logPlugin(`pat-import: failed: ${errorMessage(error)}`);
    return;
  }
  if (result.imported > 0) {
    logPlugin(
      `pat-import: imported ${result.imported} PAT(s) from ${QODER_PAT_IMPORT_ENV}` +
        (result.duplicates ? `, skipped ${result.duplicates} already stored` : "") +
        (result.invalid ? `, dropped ${result.invalid} non-pt- segment(s)` : "") +
        `. Unset ${QODER_PAT_IMPORT_ENV} to keep tokens out of child-process env.`,
    );
  } else if (result.invalid > 0) {
    logPlugin(
      `pat-import: dropped ${result.invalid} non-pt- segment(s) from ${QODER_PAT_IMPORT_ENV}`,
    );
  }
}
