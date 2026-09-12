import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  getRoutingPolicy,
  resolveRouting,
  updateRoutingPolicy,
} from "../routing-policy.js";

// Same globalThis-cache discipline as tier-store (see routing-policy.ts):
// the store realm and the request realm must agree through the shared file +
// cache, so tests exercise the persisted shape, not just the return values.
describe("routing-policy", () => {
  let savedXdg: string | undefined;
  let dir: string;
  let file: string;

  function resetCache(): void {
    delete (globalThis as Record<string, unknown>).__opencode_qoder_routing_policy;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-routing-"));
    file = join(dir, "opencode", "qoder-routing.json");
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

  describe("store", () => {
    it("falls back to the built-in defaults without a file", () => {
      expect(getRoutingPolicy()).toEqual(DEFAULT_ROUTING_POLICY);
    });

    it("persists a merged patch and re-reads it from disk cold", () => {
      const next = updateRoutingPolicy({ target: "qmodel", threshold: 400000 });
      expect(next.target).toBe("qmodel");
      expect(next.threshold).toBe(400000);
      expect(next.subagentModel).toBe(DEFAULT_ROUTING_POLICY.subagentModel);
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      expect(parsed.target).toBe("qmodel");
      resetCache();
      expect(getRoutingPolicy().target).toBe("qmodel");
    });

    it("drops unknown fields, bad values and non-string agents on read", () => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          enabled: "yes", // wrong type -> default
          target: "  qfmodel  ", // trimmed
          threshold: -5, // rejected -> default
          subagentModel: "", // rejected -> default
          exemptAgents: ["title", 42, " ", ""], // kept: ["title"]
          mystery: true, // ignored
        }),
        "utf8",
      );
      resetCache();
      const policy = getRoutingPolicy();
      expect(policy.enabled).toBe(true);
      expect(policy.target).toBe("qfmodel");
      expect(policy.threshold).toBe(DEFAULT_ROUTING_POLICY.threshold);
      expect(policy.subagentModel).toBe("lite");
      expect(policy.exemptAgents).toEqual(["title"]);
    });

    it("never blocks on a corrupt file", () => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{not json", "utf8");
      resetCache();
      expect(getRoutingPolicy()).toEqual(DEFAULT_ROUTING_POLICY);
    });
  });

  describe("resolveRouting", () => {
    const policy = DEFAULT_ROUTING_POLICY;
    const supports1M = (id: string, tokens: number) =>
      id === "qfmodel" ? tokens <= 1_000_000 : tokens <= 200_000;

    const call = (
      modelID: string,
      agent: string,
      tier: number | undefined,
      supports = supports1M,
    ) => resolveRouting({ policy, modelID, agent, sessionTier: tier, targetSupports: supports });

    it("keeps the model at or below the threshold and without a tier", () => {
      expect(call("lite", "build", undefined)).toEqual({ modelID: "lite", escalated: false });
      expect(call("lite", "build", 200000)).toEqual({ modelID: "lite", escalated: false });
    });

    it("escalates the pinned subagent model above the threshold", () => {
      expect(call("lite", "compaction", 1000000)).toEqual({
        modelID: "qfmodel",
        escalated: true,
      });
    });

    it("never touches a model the user selected", () => {
      expect(call("cmodel", "build", 1000000)).toEqual({ modelID: "cmodel", escalated: false });
    });

    it("honours the exempt agent list", () => {
      expect(call("lite", "title", 1000000)).toEqual({ modelID: "lite", escalated: false });
    });

    it("refuses to escalate onto a target that lacks the tier", () => {
      // supports() rejects qfmodel at this tier -> stay on the selected model
      // rather than send a request the gateway would 400.
      const strict = (id: string, tokens: number) => !(id === "qfmodel") && tokens <= 200_000;
      expect(call("lite", "compaction", 1000000, strict)).toEqual({
        modelID: "lite",
        escalated: false,
      });
    });

    it("respects the enabled switch", () => {
      const off = { ...policy, enabled: false };
      expect(
        resolveRouting({
          policy: off,
          modelID: "lite",
          agent: "compaction",
          sessionTier: 1000000,
          targetSupports: supports1M,
        }),
      ).toEqual({ modelID: "lite", escalated: false });
    });
  });
});
