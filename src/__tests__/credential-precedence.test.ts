import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateQoderCredentials, resolveQoderCredentials } from "../auth.js";
import { refreshKeyFile } from "../key-file.js";
import { addPAT, followConfig, invalidateStore, switchPAT } from "../pat-store.js";

// The precedence table in auth.ts is the contract that decides WHICH account a
// request signs with, and this file is the only place that exercises it as a
// whole. The pieces that make it compatible-by-default:
//
//   * a single-token key file behaves exactly like the old `{file:...}` apiKey
//     option did -- it wins until you deliberately switch;
//   * an explicit qoder_pat_switch outranks even that, because a deliberate
//     act is not ambient configuration;
//   * an apiKey option that parses as a PAT LIST is importer input (a config
//     still pointing at a multi-token seed file), never a bearer token.

const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";
const GAMMA = "pt-dddddddddddddddd";

function resetCaches(): void {
  invalidateStore();
  // The exchange cache is module state in auth.ts keyed by PAT; without this a
  // token exchanged in an earlier test replays from cache and never reaches the
  // mocked fetch, so the `requested` recorder would silently under-report.
  for (const pat of [ALPHA, BETA, GAMMA]) invalidateQoderCredentials(pat);
  for (const key of [
    "__opencode_qoder_pat_store",
    "__opencode_qoder_key_file_path",
    "__opencode_qoder_key_file_state",
    "__opencode_qoder_key_file_mtimes",
    "__opencode_qoder_exchange_cache",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

// Records which personal_token the exchange endpoint was asked about, which is
// the observable that proves WHICH layer's token reached the wire.
function recordExchanges(): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url);
    if (href.includes("/jobToken/exchange")) {
      requested.push(String(JSON.parse(String(init?.body)).personal_token));
      return Response.json({ token: "job-token", refresh_token: "r", expires_in: 86_400 });
    }
    if (href.includes("/userinfo")) {
      return Response.json({ id: "user-1", email: "u@example.com", name: "U" });
    }
    return Response.json({}, { status: 404 });
  });
  return requested;
}

let dir: string;
let keyFile: string;
let savedXdg: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-precedence-"));
  keyFile = join(dir, "keyfile");
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedKey = process.env.OPENCODE_QODER_KEY_FILE;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.OPENCODE_QODER_KEY_FILE = keyFile;
  resetCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedKey === undefined) delete process.env.OPENCODE_QODER_KEY_FILE;
  else process.env.OPENCODE_QODER_KEY_FILE = savedKey;
  rmSync(dir, { recursive: true, force: true });
  resetCaches();
});

describe("single credential compatibility", () => {
  it("a lone key-file token wins over the store's auto-active entry", async () => {
    writeFileSync(keyFile, `${ALPHA}\n`);
    refreshKeyFile();
    const beta = addPAT(BETA, "Imported 1")!; // auto-active side effect
    expect(beta.active).toBe(true);

    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA]);
  });

  it("a lone key-file token is found even with no prior refresh (lazy init)", async () => {
    writeFileSync(keyFile, `${ALPHA}\n`);
    // Deliberately NO refreshKeyFile() call: the credential chain must not
    // depend on the startup hooks having run in this process.
    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA]);
  });

  it("an explicit switch outranks the single key file, and clearing restores it", async () => {
    writeFileSync(keyFile, `${ALPHA}\n`);
    refreshKeyFile();
    addPAT(BETA, "Backup");
    const third = addPAT(GAMMA, "Third")!;
    switchPAT(third.id);

    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([GAMMA]);

    followConfig();
    await resolveQoderCredentials({});
    expect(requested).toEqual([GAMMA, ALPHA]);
  });
});

describe("list forms never authenticate", () => {
  it("an apiKey option holding a PAT list is skipped, not sent", async () => {
    // No file, no store, no env below it: the list must fall THROUGH the chain
    // to the error rather than being exchanged as if it were one token.
    const requested = recordExchanges();
    await expect(resolveQoderCredentials({ apiKey: `${ALPHA},${BETA}` })).rejects.toThrow(
      /credentials not set/,
    );
    expect(requested).toEqual([]);
  });

  it("a list-form key file seeds the store and the store signs", async () => {
    writeFileSync(keyFile, `${ALPHA}\n${BETA}\n`);
    refreshKeyFile(); // list -> import; contributes no token itself

    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA]); // the auto-active first import
  });

  it("an assignment-form key file is import, never a credential", async () => {
    writeFileSync(keyFile, `OPENCODE_QODER_PAT="${ALPHA}"`);
    refreshKeyFile();

    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA]); // via the store, not via the token slot
  });
});

describe("mtime liveness", () => {
  it("an edit to the file is honored on the next refresh, no restart", async () => {
    writeFileSync(keyFile, `${ALPHA}\n`);
    refreshKeyFile();
    const requested = recordExchanges();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA]);

    writeFileSync(keyFile, `${BETA}\n`);
    const bump = new Date(Date.now() + 5000);
    utimesSync(keyFile, bump, bump);
    refreshKeyFile();
    await resolveQoderCredentials({});
    expect(requested).toEqual([ALPHA, BETA]);
  });
});
