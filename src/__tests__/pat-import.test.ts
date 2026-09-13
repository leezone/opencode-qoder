import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../json-store.js";
import { importPATsFromEnv, maybeImportPATsFromEnv, parseImportValue } from "../pat-import.js";
import { invalidateStore, listPATs } from "../pat-store.js";

// A valid-looking PAT only has to survive patID()'s slice + the pt- shape test.
const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";
const GAMMA = "pt-cccccccccccccccc";

function resetCaches(): void {
  invalidateStore();
  delete (globalThis as Record<string, unknown>).__opencode_qoder_pat_store;
}

describe("parseImportValue", () => {
  it("splits on commas and semicolons, trimming whitespace", () => {
    expect(parseImportValue(`${ALPHA}, ${BETA} ;${GAMMA}`)).toEqual({
      pats: [ALPHA, BETA, GAMMA],
      invalid: 0,
    });
  });

  it("passes a single bare PAT through unchanged", () => {
    expect(parseImportValue(ALPHA)).toEqual({ pats: [ALPHA], invalid: 0 });
  });

  it("drops non-pt- segments but keeps the valid ones", () => {
    const parsed = parseImportValue(`${ALPHA},sk-jobtoken,${BETA}`);
    expect(parsed.pats).toEqual([ALPHA, BETA]);
    expect(parsed.invalid).toBe(1);
  });

  it("treats blank segments as nothing, not invalid", () => {
    expect(parseImportValue(`${ALPHA},, ,`)).toEqual({ pats: [ALPHA], invalid: 0 });
  });

  it("an empty value yields no pats", () => {
    expect(parseImportValue("")).toEqual({ pats: [], invalid: 0 });
  });
});

describe("importPATsFromEnv", () => {
  let savedXdg: string | undefined;
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-pat-import-"));
    file = join(dir, "opencode", "qoder-pats.json");
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    resetCaches();
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });

  it("does nothing when the variable is absent", () => {
    expect(importPATsFromEnv({})).toEqual({ imported: 0, duplicates: 0, invalid: 0 });
    expect(listPATs()).toEqual([]);
  });

  it("imports each PAT and auto-activates the first (empty store)", () => {
    const result = importPATsFromEnv({ OPENCODE_QODER_PAT: `${ALPHA},${BETA}` });
    expect(result).toEqual({ imported: 2, duplicates: 0, invalid: 0 });
    const stored = listPATs();
    expect(stored.map((p) => p.active)).toEqual([true, false]);
  });

  it("is idempotent: a second run stores nothing new", () => {
    importPATsFromEnv({ OPENCODE_QODER_PAT: `${ALPHA},${BETA}` });
    const again = importPATsFromEnv({ OPENCODE_QODER_PAT: `${ALPHA},${BETA}` });
    expect(again).toEqual({ imported: 0, duplicates: 2, invalid: 0 });
    expect(listPATs()).toHaveLength(2);
  });

  it("never steals the active flag from an existing account", () => {
    importPATsFromEnv({ OPENCODE_QODER_PAT: ALPHA });
    importPATsFromEnv({ OPENCODE_QODER_PAT: BETA });
    const stored = listPATs();
    expect(stored.find((p) => p.pat === ALPHA)?.active).toBe(true);
    expect(stored.find((p) => p.pat === BETA)?.active).toBe(false);
  });

  it("counts invalid segments and still imports the valid ones", () => {
    const result = importPATsFromEnv({ OPENCODE_QODER_PAT: `${ALPHA},oops,${BETA}` });
    expect(result).toEqual({ imported: 2, duplicates: 0, invalid: 1 });
  });

  it("persists to the store file", () => {
    importPATsFromEnv({ OPENCODE_QODER_PAT: `${ALPHA},${BETA}` });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.entries).toHaveLength(2);
  });
});

describe("maybeImportPATsFromEnv", () => {
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-pat-maybe-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.OPENCODE_QODER_PAT;
    process.env.XDG_CONFIG_HOME = dir;
    resetCaches();
    delete (globalThis as Record<string, unknown>).__opencode_qoder_pat_import_done;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.OPENCODE_QODER_PAT;
    else process.env.OPENCODE_QODER_PAT = savedEnv;
    rmSync(dir, { recursive: true, force: true });
    resetCaches();
    delete (globalThis as Record<string, unknown>).__opencode_qoder_pat_import_done;
  });

  it("seeds the store from the real environment at startup", () => {
    process.env.OPENCODE_QODER_PAT = `${ALPHA};${BETA}`;
    maybeImportPATsFromEnv();
    expect(listPATs()).toHaveLength(2);
  });
});

describe("json-store file mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-json-mode-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Windows has no POSIX bits and CI may run there; only assert where the mode
  // is real.
  it.skipIf(process.platform === "win32")("tightens a re-written file to 0600", () => {
    const path = join(dir, "secret.json");
    expect(writeJsonFile("test", path, { a: 1 })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Re-write over the existing file must keep it private (the mode option on
    // writeFileSync would NOT, since it only applies at create).
    expect(writeJsonFile("test", path, { a: 2 })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
