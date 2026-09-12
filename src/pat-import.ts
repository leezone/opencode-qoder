import { QODER_PAT_IMPORT_ENV } from "./constants.js";
import { readEnv } from "./env.js";
import { errorMessage, logPlugin } from "./log.js";
import { addPAT, listPATs } from "./pat-store.js";

// Multi-PAT bootstrap import from OPENCODE_QODER_PAT.
//
// This is the intake side of the multi-account story. The durable, switchable
// home for several PATs is the pat-store (qoder-pats.json, one `active` flag);
// this module exists only to SEED that store from the environment, so a fresh
// box or CI runner can be provisioned with `OPENCODE_QODER_PAT=pt-a,pt-b` and
// need no interactive /connect or qoder_pat_add. After the seed the variable is
// redundant -- the store -- not the variable -- is what auth later requests.
//
// Precedence is untouched: OPENCODE_QODER_PAT is NOT a credential-resolution
// layer (see constants.ts). It is consumed here and nowhere else. Importing is
// idempotent (addPAT dedupes by patID), so re-running it on every process start
// with the variable still set is a no-op.
//
// We deliberately require the `pt-` prefix. The resolution chain treats a
// non-pt- token as an already-exchanged job token and passes it through; the
// store is for long-lived PATs, so a raw job token must not be persisted as if
// it were one. Non-pt- segments are dropped (counted, never logged).

export interface ImportResult {
  imported: number;
  duplicates: number;
  invalid: number;
}

// Comma is the documented primary (a bare value needs no shell quoting);
// semicolon is accepted for PATH-style muscle memory. Surrounding whitespace
// around each segment is trimmed away.
const SEGMENT_SPLIT = /[;,]/;
const PAT_SHAPE = /^pt-/;

// Pure: the parsing/validation half, split out so the side-effecting importer is
// thin and the segment rules are directly testable.
export function parseImportValue(value: string): { pats: string[]; invalid: number } {
  const pats: string[] = [];
  let invalid = 0;
  for (const raw of value.split(SEGMENT_SPLIT)) {
    const segment = raw.trim();
    if (!segment) continue; // a trailing/blank segment is nothing, not invalid.
    if (PAT_SHAPE.test(segment)) pats.push(segment);
    else invalid += 1;
  }
  return { pats, invalid };
}

// Reads OPENCODE_QODER_PAT and imports every valid, not-already-stored PAT.
// Returns counts for the caller's log. Never throws: a broken store write is
// already swallowed inside addPAT/saveStore, and a malformed value is simply
// counted invalid. The token VALUES never reach the log -- counts only.
export function importPATsFromEnv(env: NodeJS.ProcessEnv = process.env): ImportResult {
  const result: ImportResult = { imported: 0, duplicates: 0, invalid: 0 };
  const raw = env[QODER_PAT_IMPORT_ENV];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return result;

  const { pats, invalid } = parseImportValue(value);
  result.invalid = invalid;
  const before = listPATs().length;
  for (const [offset, pat] of pats.entries()) {
    const label = `Imported ${before + offset + 1}`;
    const entry = addPAT(pat, label);
    if (entry) result.imported += 1;
    else result.duplicates += 1;
  }
  return result;
}

// The once-per-process startup call. Runs before discovery so a freshly seeded
// store can authenticate the very first catalog refresh. Logs only when it
// actually changed something or dropped something, so a steady-state process
// (variable unset, or every PAT already stored) stays quiet.
export function maybeImportPATsFromEnv(): void {
  let result: ImportResult;
  try {
    result = importPATsFromEnv();
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
