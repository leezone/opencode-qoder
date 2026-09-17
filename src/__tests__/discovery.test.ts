import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCatalog } from "../model-catalog.js";
import { transformPrompt } from "../transform.js";

const assistantWithToolCallOnly: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "list the files" }] },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "ls", input: {} }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "ls",
        output: { type: "text", value: "a.ts" },
      },
    ],
  },
];

describe("assistant content regression (Kimi 400)", () => {
  afterEach(() => {
    delete process.env.QODER_REASONING_EFFORT;
  });

  it("emits an empty string instead of null when a tool-call turn has no prose", async () => {
    const { messages } = await transformPrompt(assistantWithToolCallOnly);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    // Moonshot rejects assistant tool_calls with content:null ("tool_call_id
    // is not found"); an empty string is accepted by every upstream.
    expect(assistant!.content).toBe("");
    expect(assistant!.tool_calls).toHaveLength(1);
  });

  it("still keeps reasoning+text prose in the content", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "doing it" },
        ],
      },
    ];
    const { messages } = await transformPrompt(prompt);
    expect(messages[0].content).toBe("<thinking>hmm</thinking>\n\ndoing it");
  });
});

describe("parseCatalog", () => {
  it("clamps limits to the DEFAULT context tier, not the largest one", () => {
    const models = parseCatalog({
      chat: [
        {
          key: "kmodel_latest",
          display_name: "Kimi",
          max_input_tokens: 180000,
          context_config: {
            "1M": { token_count: 1000000 },
            "200K": { token_count: 200000, is_default: true },
          },
          thinking_config: { enabled: { efforts: { high: {}, low: {}, max: {} } } },
        },
      ],
    });
    const model = models.find((entry) => entry.id === "kmodel_latest")!;
    // max_input_tokens is the input budget OF the default tier here; trusting
    // the 1M tier would defer auto-compaction until ~980k tokens.
    expect(model.contextWindow).toBe(200000);
    expect(model.inputWindow).toBe(180000);
    expect(model.efforts).toEqual(["high", "low", "max"]);
    expect(model.supportsEffort).toBe(true);
    // The full tier table is retained for the tier picker, ascending.
    expect(model.contextTiers).toEqual([200000, 1000000]);
  });

  it("omits contextTiers when upstream lists fewer than two usable windows", () => {
    const models = parseCatalog({
      chat: [
        {
          key: "single",
          max_input_tokens: 180000,
          context_config: { "200K": { token_count: 200000, is_default: true } },
        },
        {
          key: "garbage",
          max_input_tokens: 180000,
          context_config: { a: { token_count: -5 }, b: { token_count: "x" } },
        },
        { key: "none", max_input_tokens: 180000 },
      ],
    });
    expect(models.find((entry) => entry.id === "single")!.contextTiers).toBeUndefined();
    expect(models.find((entry) => entry.id === "garbage")!.contextTiers).toBeUndefined();
    expect(models.find((entry) => entry.id === "none")!.contextTiers).toBeUndefined();
  });

  it("validates request tiers against the advertised table", async () => {
    const { isValidContextTier } = await import("../model-catalog.js");
    const models = parseCatalog({
      chat: [
        {
          key: "tiered",
          max_input_tokens: 180000,
          context_config: {
            "1M": { token_count: 1000000 },
            "200K": { token_count: 200000, is_default: true },
          },
        },
        { key: "plain", max_input_tokens: 180000 },
      ],
    });
    const tiered = models.find((entry) => entry.id === "tiered")!;
    const plain = models.find((entry) => entry.id === "plain")!;
    // With a tier table: exact members only, mirroring qodercli's qq().
    expect(isValidContextTier(tiered, 200000)).toBe(true);
    expect(isValidContextTier(tiered, 1000000)).toBe(true);
    expect(isValidContextTier(tiered, 500000)).toBe(false);
    expect(isValidContextTier(tiered, 0)).toBe(false);
    // Without a table: bounded by the input budget.
    expect(isValidContextTier(plain, 180000)).toBe(true);
    expect(isValidContextTier(plain, 180001)).toBe(false);
  });

  it("rejects a schema-drifted batch with no recognisable limits", () => {
    expect(() => parseCatalog({ chat: [{ key: "x", mystery_number: 123456789 }] })).toThrow(
      /no recognisable token limits/,
    );
  });

  it("re-injects the default model when upstream stopped advertising it", () => {
    const models = parseCatalog({ chat: [{ key: "kmodel_latest", max_input_tokens: 180000 }] });
    expect(models[0].id).toBe("auto");
  });

  it("drops explicitly disabled models", () => {
    const models = parseCatalog({
      chat: [
        { key: "kmodel_latest", max_input_tokens: 180000 },
        { key: "lite", enable: false },
      ],
    });
    expect(models.map((model) => model.id)).not.toContain("lite");
  });

  // Fixture mirrors the live payload observed from
  // https://api3.qoder.sh/algo/api/v2/model/list: Qwen3.8-Max advertises
  // price_factor 0.5 together with is_free true and an inactive promotion.
  it("reads the credit multiplier the live list advertises", () => {
    const models = parseCatalog({
      chat: [
        {
          key: "qmodel_38max",
          display_name: "Qwen3.8-Max",
          max_input_tokens: 180000,
          price_factor: 0.5,
          is_free: true,
          promotion: { active: false, before_promotion_price_factor: 0.5 },
        },
      ],
    });
    const model = models.find((entry) => entry.id === "qmodel_38max")!;
    expect(model.priceFactor).toBe(0.5);
  });

  it("accepts the camelCase spelling of the same field", () => {
    const models = parseCatalog({
      chat: [{ key: "kmodel_latest", max_input_tokens: 180000, priceFactor: 0.8 }],
    });
    expect(models.find((entry) => entry.id === "kmodel_latest")!.priceFactor).toBe(0.8);
  });

  it("keeps a fractional multiplier instead of flooring it to zero", () => {
    // GLM-5.3-Flash bills 0.05; pickInt would floor it and render it free.
    const models = parseCatalog({
      chat: [{ key: "gfmodel", max_input_tokens: 180000, price_factor: 0.05 }],
    });
    expect(models.find((entry) => entry.id === "gfmodel")!.priceFactor).toBe(0.05);
  });

  it("leaves the multiplier absent rather than inventing one", () => {
    const models = parseCatalog({ chat: [{ key: "kmodel_latest", max_input_tokens: 180000 }] });
    // A guessed 1 would display a multiplier Qoder never advertised.
    expect(models.find((entry) => entry.id === "kmodel_latest")!.priceFactor).toBeUndefined();
  });

  it("merges models from the frontier group", () => {
    const models = parseCatalog({
      chat: [{ key: "auto", max_input_tokens: 180000 }],
      frontier: [{ key: "cmodel", display_name: "Cantus", max_input_tokens: 1000000 }],
    });
    const ids = models.map((model) => model.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("cmodel");
  });

  it("deduplicates models that appear in both chat and frontier", () => {
    const models = parseCatalog({
      chat: [{ key: "auto", max_input_tokens: 180000 }],
      frontier: [{ key: "auto", max_input_tokens: 180000 }],
    });
    const autoModels = models.filter((model) => model.id === "auto");
    expect(autoModels).toHaveLength(1);
  });
});

// opencode loads the plugin twice per process (legacy + v2 realms) and only
// the v2 realm refreshes; the realms share state exclusively through the disk
// cache. The serving realm must therefore adopt a peer-written cache, or a
// model's context tiers -- parsed only on a live refresh -- stay invisible to
// the request path and parameters.context_length never rides the wire.
describe("cross-realm disk-cache adoption", () => {
  const CACHE_VERSION = 1;

  function cachedModel(withTiers: boolean) {
    return {
      id: "cmodel",
      name: "Cantus",
      reasoning: true,
      supportsEffort: false,
      efforts: [],
      input: ["text"],
      contextWindow: 200000,
      inputWindow: 200000,
      maxTokens: 32768,
      origin: "qoder",
      ...(withTiers ? { contextTiers: [200000, 400000, 1000000] } : {}),
    };
  }

  function writeCache(file: string, withTiers: boolean, fetchedAt: number, mtimeSec: number): void {
    writeFileSync(
      file,
      JSON.stringify({ version: CACHE_VERSION, fetchedAt, models: [cachedModel(withTiers)] }),
    );
    // Explicit mtimes keep the stat comparison deterministic regardless of how
    // fast the two writes land on the real clock.
    utimesSync(file, mtimeSec, mtimeSec);
  }

  it("adopts a peer refresh that arrived after this realm seeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-adopt-"));
    const cache = join(dir, "models.json");
    const t0 = 1_700_000_000_000;
    writeCache(cache, false, t0, t0 / 1000);
    vi.stubEnv("QODER_MODEL_DISK_CACHE", cache);
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    try {
      vi.resetModules();
      const mod = await import("../model-catalog.js");
      // The serving realm seeds the tier-less snapshot and reports it.
      expect(mod.getModelDefinition("cmodel").contextTiers).toBeUndefined();

      // Peer realm refreshes ~1s later and persists the parsed table.
      writeCache(cache, true, t0 + 1000, t0 / 1000 + 5);
      vi.setSystemTime(t0 + 1000);
      expect(mod.getModelDefinition("cmodel").contextTiers).toBeUndefined(); // still throttled

      // Past the poll interval the newer file is adopted...
      vi.setSystemTime(t0 + 6000);
      expect(mod.getModelDefinition("cmodel").contextTiers).toEqual([200000, 400000, 1000000]);
      expect(mod.catalogStatus().fetchedAt).toBe(t0 + 1000);

      // ...and the adoption is sticky-cheap: an unchanged file is not reparsed.
      writeCache(cache, false, t0 + 2000, t0 / 1000 + 5);
      vi.setSystemTime(t0 + 12000);
      expect(mod.getModelDefinition("cmodel").contextTiers).toEqual([200000, 400000, 1000000]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
