import { afterEach, describe, expect, it } from "vitest";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { transformPrompt } from "../transform.js";
import { parseCatalog } from "../model-catalog.js";

const assistantWithToolCallOnly: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "list the files" }] },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "ls", input: {} }],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_1", toolName: "ls", output: { type: "text", value: "a.ts" } }],
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
});
