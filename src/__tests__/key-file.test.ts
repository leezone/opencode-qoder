import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFilePath, keyFileToken, refreshKeyFile, setKeyFilePath } from "../key-file.js";
import { invalidateStore, listPATs } from "../pat-store.js";

// The seed key file is the plugin-owned replacement for opencode's
// `{file:...}` apiKey option. The grammar decides the role: a lone token is a
// credential that flows through resolution; a list seeds the pat-store and the
// store takes over. The mtime gate is what makes it LIVE -- an edit lands
// within a refresh tick, no restart.

const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";
const GAMMA = "pt-cccccccccccccccc";

let dir: string;
let file: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function resetCaches(): void {
  invalidateStore();
  for (const key of [
    "__opencode_qoder_pat_store",
    "__opencode_qoder_key_file_path",
    "__opencode_qoder_key_file_state",
    "__opencode_qoder_key_file_mtimes",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-key-file-"));
  file = join(dir, "keyfile");
  savedEnv = process.env.OPENCODE_QODER_KEY_FILE;
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.OPENCODE_QODER_KEY_FILE = file;
  process.env.XDG_CONFIG_HOME = dir;
  resetCaches();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPENCODE_QODER_KEY_FILE;
  else process.env.OPENCODE_QODER_KEY_FILE = savedEnv;
  process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
  resetCaches();
});

describe("key file as credential", () => {
  it("a lone token is the credential and touches nothing", () => {
    writeFileSync(file, `${ALPHA}\n`);
    expect(refreshKeyFile().kind).toBe("single");
    expect(keyFileToken()).toBe(ALPHA);
    // The credential form is passive: no store file is created for it.
    expect(listPATs()).toEqual([]);
  });

  it("a lone non-pt- token is a passthrough credential, not junk", () => {
    writeFileSync(file, "sk-job-token");
    expect(refreshKeyFile().kind).toBe("single");
    expect(keyFileToken()).toBe("sk-job-token");
    expect(listPATs()).toEqual([]);
  });

  it("an absent file is quiet and contributes no credential", () => {
    expect(refreshKeyFile().kind).toBe("absent");
    expect(keyFileToken()).toBe("");
  });

  it("an empty file behaves like no file", () => {
    writeFileSync(file, "\n");
    expect(refreshKeyFile().kind).toBe("absent");
    expect(keyFileToken()).toBe("");
  });

  it('"none" disables the layer entirely', () => {
    process.env.OPENCODE_QODER_KEY_FILE = "none";
    writeFileSync(file, ALPHA);
    expect(refreshKeyFile().kind).toBe("disabled");
    expect(keyFileToken()).toBe("");
  });

  it("the configured option path wins over the env override", () => {
    const other = join(dir, "option-file");
    setKeyFilePath(other);
    expect(keyFilePath()).toBe(other);
    writeFileSync(other, BETA);
    expect(refreshKeyFile().kind).toBe("single");
    expect(keyFileToken()).toBe(BETA);
  });
});

describe("key file as seed import", () => {
  it("a comma list imports the store and stops being a credential", () => {
    writeFileSync(file, `${ALPHA},${BETA}`);
    expect(refreshKeyFile().kind).toBe("list");
    expect(keyFileToken()).toBe("");
    const stored = listPATs();
    expect(stored).toHaveLength(2);
    expect(stored.filter((e) => e.active)).toHaveLength(1);
  });

  it("accepts one-PAT-per-line and # comments", () => {
    writeFileSync(file, `# my accounts\n${ALPHA}\n${BETA}\n`);
    expect(refreshKeyFile().kind).toBe("list");
    expect(listPATs()).toHaveLength(2);
  });

  it("accepts the OPENCODE_QODER_PAT= assignment form", () => {
    writeFileSync(file, `OPENCODE_QODER_PAT="${ALPHA};${BETA}"`);
    expect(refreshKeyFile().kind).toBe("list");
    expect(listPATs()).toHaveLength(2);
  });

  it("an mtime-steady refresh neither re-imports nor re-reads", () => {
    // Fix the stamp before the first read so later content writes can restore
    // it exactly (a plain write would otherwise advance the mtime).
    const stamp = new Date(1_700_000_000_000);
    writeFileSync(file, `${ALPHA},${BETA}`);
    utimesSync(file, stamp, stamp);
    refreshKeyFile();
    expect(listPATs()).toHaveLength(2);

    writeFileSync(file, `${ALPHA},${BETA},${GAMMA}`);
    utimesSync(file, stamp, stamp); // same mtime: the gate must miss the write
    refreshKeyFile();
    expect(listPATs()).toHaveLength(2);

    const later = new Date(stamp.getTime() + 1000);
    utimesSync(file, later, later); // now the change is seen: GAMMA imports,
    refreshKeyFile(); // ALPHA/BETA dedup by id
    expect(listPATs()).toHaveLength(3);
  });

  it("an edit lands on the next tick, no restart", () => {
    writeFileSync(file, ALPHA);
    refreshKeyFile();
    expect(keyFileToken()).toBe(ALPHA);

    // The user adds a second account: the file flips to a list, the store
    // takes over authentication.
    writeFileSync(file, `${ALPHA}\n${BETA}\n`);
    utimesSync(file, new Date(), new Date(Date.now() + 1000));
    expect(refreshKeyFile().kind).toBe("list");
    expect(keyFileToken()).toBe("");
    expect(listPATs()).toHaveLength(2);
  });
});

describe("key file as a shell env file", () => {
  it("extracts OPENCODE_QODER_PAT from export lines and imports the list", () => {
    writeFileSync(
      file,
      `export QODER_PERSONAL_ACCESS_TOKEN="${GAMMA}"\n` +
        `export OPENCODE_QODER_PAT="${ALPHA},${BETA}"\n` +
        `# qoderkey: someone\n`,
    );
    expect(refreshKeyFile().kind).toBe("list");
    expect(keyFileToken()).toBe(""); // a list never authenticates as one token
    // The list wins over the single-token variable, and the imported ids prove
    // the tokens came from the assignment's VALUE -- never the whole
    // `export ...` line (patID = "pat_" + the 12 chars after "pt-").
    expect(listPATs().map((p) => p.id)).toEqual([
      `pat_${ALPHA.slice(3, 15)}`,
      `pat_${BETA.slice(3, 15)}`,
    ]);
  });

  it("uses QODER_PERSONAL_ACCESS_TOKEN as the credential when no list exists", () => {
    writeFileSync(file, `export QODER_PERSONAL_ACCESS_TOKEN="${ALPHA}"\n# comment\n`);
    expect(refreshKeyFile().kind).toBe("single");
    expect(keyFileToken()).toBe(ALPHA); // not `export QODER_...="pt-..."` verbatim
    expect(listPATs()).toHaveLength(0);
  });

  it("handles single quotes and unquoted assignments", () => {
    writeFileSync(file, `export OPENCODE_QODER_PAT='${ALPHA}'`);
    expect(refreshKeyFile().kind).toBe("single");
    expect(keyFileToken()).toBe(ALPHA);
    writeFileSync(file, `export OPENCODE_QODER_PAT=${ALPHA},${BETA}`);
    utimesSync(file, new Date(), new Date(Date.now() + 1000));
    expect(refreshKeyFile().kind).toBe("list");
    expect(listPATs()).toHaveLength(2);
  });
});
