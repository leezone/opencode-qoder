import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { transformPrompt, transformTools } from "../transform.js";

describe("transformPrompt", () => {
  it("maps system, user, assistant tool calls, and tool results", async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are useful." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "I will call a tool." },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { file: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ];

    expect(await transformPrompt(prompt)).toEqual({
      system: "You are useful.",
      lastUserText: "hi",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "<thinking>thinking</thinking>\n\nI will call a tool.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"file":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
    });
  });

  it("maps image files to OpenAI-compatible image_url parts", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    ];

    expect((await transformPrompt(prompt)).messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    });
  });

  it("prefers a published URL when the resolver yields one", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "aGVsbG8=" }],
      },
    ];
    const resolver = (data: Uint8Array, mediaType: string) => {
      expect(mediaType).toBe("image/png");
      expect(Buffer.from(data).toString()).toBe("hello");
      return "https://cdn.test/published.png";
    };
    const { messages } = await transformPrompt(prompt, resolver);
    expect(messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://cdn.test/published.png" } },
    ]);
  });

  it("falls back to the inline data URL when publication fails", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "aGVsbG8=" }],
      },
    ];
    const throwing = () => {
      throw new Error("upload exploded");
    };
    const { messages } = await transformPrompt(prompt, throwing);
    expect(messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
  });

  it("passes an absolute URL through without invoking the resolver", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "https://cdn.test/already.png" }],
      },
    ];
    let called = false;
    const { messages } = await transformPrompt(prompt, () => {
      called = true;
      return undefined;
    });
    expect(called).toBe(false);
    expect(messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://cdn.test/already.png" } },
    ]);
  });
});

describe("transformTools", () => {
  it("maps function tools and counts unsupported provider tools", () => {
    const result = transformTools([
      {
        type: "function",
        name: "read",
        inputSchema: { type: "object" },
        description: "Read a file",
      },
      { type: "provider", id: "qoder.web_search", name: "web_search", args: {} },
    ]);

    expect(result).toEqual({
      ignoredTools: 1,
      tools: [
        {
          type: "function",
          function: { name: "read", description: "Read a file", parameters: { type: "object" } },
        },
      ],
    });
  });
});
