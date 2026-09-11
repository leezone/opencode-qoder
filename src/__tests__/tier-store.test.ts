import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAllTiers,
  clearSessionTier,
  clearTier,
  getSelectedTier,
  getSessionTier,
  listSelectedTiers,
  listSessionTiers,
  setSessionTier,
  setTier,
} from "../tier-store.js";

// Tier state must be visible across plugin instances. opencode loads this
// plugin twice per process, and module state does not reach the second
// instance -- the store therefore lives on globalThis (see tier-store.ts).
// The persistence path (file shape + re-seeding) is what these tests pin down.
describe("tier-store", () => {
  let savedXdg: string | undefined;
  let dir: string;
  let file: string;

  function resetCache(): void {
    delete (globalThis as Record<string, unknown>).__opencode_qoder_tier_store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-tiers-"));
    file = join(dir, "opencode", "qoder-tiers.json");
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    resetCache();
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(dir, { recursive: true, force: true });
    resetCache();
  });

  describe("display mode", () => {
    it("starts with no selection", () => {
      expect(getSelectedTier("cmodel")).toBeUndefined();
      expect(listSelectedTiers()).toEqual({});
    });

    it("persists a selection under the v2 `mode` key", () => {
      expect(setTier("cmodel", 1000000)).toBe(true);
      expect(getSelectedTier("cmodel")).toBe(1000000);
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.mode.cmodel).toBe(1000000);
    });

    it("round-trips through the file after the cache is cleared", () => {
      setTier("ultimate", 400000);
      // Drop the globalThis cache so the next read re-seeds from disk, the way a
      // cold second instance would.
      resetCache();
      expect(getSelectedTier("ultimate")).toBe(400000);
    });

    it("clears a selection back to the default tier", () => {
      setTier("cmodel", 1000000);
      expect(clearTier("cmodel")).toBe(true);
      expect(getSelectedTier("cmodel")).toBeUndefined();
      expect(clearTier("cmodel")).toBe(false);
    });

    it("migrates a v1 file whose map was named `selections`", () => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ selections: { cmodel: 1000000 } }), "utf8");
      resetCache();
      expect(getSelectedTier("cmodel")).toBe(1000000);
    });

    it("rejects empty model ids and non-positive token counts", () => {
      expect(setTier("", 1000000)).toBe(false);
      expect(setTier("cmodel", 0)).toBe(false);
      expect(setTier("cmodel", -1)).toBe(false);
      expect(setTier("cmodel", 999.5)).toBe(false);
      expect(getSelectedTier("cmodel")).toBeUndefined();
    });

    it("clearAllTiers resets only the display mode, keeping session tiers", () => {
      setTier("cmodel", 1000000);
      setSessionTier("ses_root", 1000000);
      expect(clearAllTiers()).toBe(true);
      expect(listSelectedTiers()).toEqual({});
      expect(getSessionTier("ses_root")).toBe(1000000);
      expect(clearAllTiers()).toBe(false);
    });
  });

  describe("session tiers", () => {
    it("defaults to undefined -- a session that never switched rides the model default", () => {
      expect(getSessionTier("ses_new")).toBeUndefined();
      expect(listSessionTiers()).toEqual({});
    });

    it("persists as {tokens, at} entries", () => {
      expect(setSessionTier("ses_root", 400000)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.sessions.ses_root.tokens).toBe(400000);
      expect(typeof parsed.sessions.ses_root.at).toBe("number");
    });

    it("survives a cold cache, the way the request realm reads it", () => {
      setSessionTier("ses_root", 1000000);
      resetCache();
      expect(getSessionTier("ses_root")).toBe(1000000);
    });

    it("drops entries older than the TTL at the next load", () => {
      mkdirSync(join(file, ".."), { recursive: true });
      const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000;
      writeFileSync(
        file,
        JSON.stringify({ mode: {}, sessions: { ses_old: { tokens: 1000000, at: ancient } } }),
        "utf8",
      );
      resetCache();
      expect(getSessionTier("ses_old")).toBeUndefined();
      resetCache();
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.sessions.ses_old).toBeUndefined();
    });

    it("accepts a bare-number entry (tolerant read) and clears", () => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ mode: {}, sessions: { ses_bare: 272000 } }), "utf8");
      resetCache();
      expect(getSessionTier("ses_bare")).toBe(272000);
      expect(clearSessionTier("ses_bare")).toBe(true);
      expect(clearSessionTier("ses_bare")).toBe(false);
    });

    it("rejects empty ids and non-positive counts", () => {
      expect(setSessionTier("", 1000000)).toBe(false);
      expect(setSessionTier("ses_a", 0)).toBe(false);
      expect(setSessionTier("ses_a", 1.5)).toBe(false);
    });
  });
});
