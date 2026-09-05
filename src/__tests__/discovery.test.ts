import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
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

  it("emits an empty string instead of null when a tool-call turn has no prose", () => {
    const { messages } = transformPrompt(assistantWithToolCallOnly);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    // Moonshot rejects assistant tool_calls with content:null ("tool_call_id
    // is not found"); an empty string is accepted by every upstream.
    expect(assistant!.content).toBe("");
    expect(assistant!.tool_calls).toHaveLength(1);
  });

  it("still keeps reasoning+text prose in the content", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "doing it" },
        ],
      },
    ];
    const { messages } = transformPrompt(prompt);
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
});
