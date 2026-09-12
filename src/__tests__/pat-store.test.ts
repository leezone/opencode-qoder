import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPAT, invalidateStore, listPATs, patStoreFile, switchPAT } from "../pat-store.js";

// The shell escape hatch only works if the running plugin notices a write it
// did not make. That is the mtime check in loadStore(): an external flip of
// `active` -- the qoder-quota script's --use-pat, or a hand edit -- must be
// visible on the very next read, with no restart.

const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";

function resetCaches(): void {
  invalidateStore();
  delete (globalThis as Record<string, unknown>).__opencode_qoder_pat_store;
}

function activeIds(): string[] {
  return listPATs()
    .filter((e) => e.active)
    .map((e) => e.id);
}

let savedXdg: string | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-pat-store-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  resetCaches();
});

afterEach(() => {
  resetCaches();
  process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("pat-store mtime reload", () => {
  it("adopts an external active flip without a restart", () => {
    const beta = addPAT(ALPHA, "Primary") && addPAT(BETA, "Backup")!;
    expect(activeIds()).toEqual([listPATs()[0].id]);

    // Simulate the recovery script: rewrite the file on disk, flipping active.
    const path = patStoreFile();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const entry of raw.entries) entry.active = entry.id === beta.id;
    writeFileSync(path, JSON.stringify(raw, null, 2));
    // Bump mtime explicitly: detection is mtime-based, and a coarse-granularity
    // filesystem could otherwise land this write in the same tick as saveStore's.
    const now = new Date();
    utimesSync(path, now, new Date(now.getTime() + 1000));

    expect(activeIds()).toEqual([beta.id]);
  });

  it("keeps its own writes authoritative (no stale-cache ping-pong)", () => {
    addPAT(ALPHA, "Primary");
    const beta = addPAT(BETA, "Backup")!;
    expect(switchPAT(beta.id)).toBe(true);
    expect(activeIds()).toEqual([beta.id]);
    // A second load must not re-read older bytes over the newer in-memory state.
    expect(listPATs().find((e) => e.id === beta.id)?.active).toBe(true);
  });

  it("sees a file that appears after a first empty read", () => {
    expect(listPATs()).toEqual([]); // cache stamped -1 (missing file)
    addPAT(ALPHA, "Primary");
    expect(activeIds()).not.toEqual([]);
  });

  it("sees a deletion", () => {
    addPAT(ALPHA, "Primary");
    expect(activeIds().length).toBe(1);
    const path = patStoreFile();
    const { rmSync: rm } = { rmSync };
    rm(path);
    expect(listPATs()).toEqual([]);
  });

  it("ignores a touch that does not change mtime semantics it cannot see", () => {
    // Rewriting identical content bumps mtime and re-reads the same bytes; the
    // cache must still agree with disk afterwards.
    addPAT(ALPHA, "Primary");
    const path = patStoreFile();
    writeFileSync(path, readFileSync(path, "utf8"));
    expect(activeIds().length).toBe(1);
  });
});
