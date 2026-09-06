import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QoderLanguageModel } from "../language-model.js";

// End-to-end tests for the streaming machinery: the SSE line parser, the
// thinking-tag extractor, the StreamEmitter block pairing, and the tool-call
// delta state machine -- all driven through QoderLanguageModel.doStream() with
// a stubbed fetch, exactly as the AI SDK would consume them.

// A non-"pt-" token short-circuits resolveQoderCredentials(), so the tests
// never hit the token-exchange endpoint; fetch only serves the chat endpoint.
const credentials = { apiKey: "test-job-token" };

const prompt: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

const callOptions = { prompt } as LanguageModelV3CallOptions;

// Wraps a chunk payload in Qoder's SSE envelope, as the gateway streams it.
function envelope(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`;
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetch(lines: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(lines)),
  );
}

async function collect(lines: string[]): Promise<LanguageModelV3StreamPart[]> {
  stubFetch(lines);
  const model = new QoderLanguageModel("auto", credentials);
  const result = await model.doStream(callOptions);
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

function of(parts: LanguageModelV3StreamPart[], type: LanguageModelV3StreamPart["type"]) {
  return parts.filter((part) => part.type === type);
}

let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "qoder-stream-"));
  // Keeps model-catalog's import-time disk-cache seed out of the real
  // ~/.cache/opencode, so the model definition lookup is hermetic.
  process.env.QODER_MODEL_DISK_CACHE = join(cacheDir, "models.json");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QODER_MODEL_DISK_CACHE;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("doStream: plain text", () => {
  it("pairs text blocks and maps the finish reason", async () => {
    const parts = await collect([
      envelope({ id: "resp-1", model: "m1", created: 1700000000 }),
      envelope({ choices: [{ delta: { content: "Hello" } }] }),
      envelope({ choices: [{ delta: { content: " world" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(of(parts, "response-metadata")).toEqual([
      {
        type: "response-metadata",
        id: "resp-1",
        modelId: "m1",
        timestamp: new Date(1_700_000_000_000),
      },
    ]);
    // One block, opened once, closed once -- the deltas between carry it all.
    expect(of(parts, "text-start")).toHaveLength(1);
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("Hello world");
    expect(of(parts, "text-end")).toHaveLength(1);
    const finish = parts.at(-1)!;
    expect(finish).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
  });

  it("maps raw usage including cache and reasoning tokens", async () => {
    const parts = await collect([
      envelope({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    const finish = parts.at(-1)!;
    expect(finish).toMatchObject({
      type: "finish",
      usage: {
        inputTokens: { total: 100, cacheRead: 40, noCache: 60 },
        outputTokens: { total: 20, reasoning: 5 },
      },
    });
  });

  it("emits a protocol error part and an error finish when the envelope carries a failure", async () => {
    const parts = await collect(['data: {"statusCodeValue":429,"body":"rate limited"}\n\n']);

    const errors = of(parts, "error");
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { error: unknown }).error)).toContain("429");
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } });
  });

  it("drops malformed data lines instead of failing the whole stream", async () => {
    // A proxy can inject or truncate a line mid-body; the stream that is
    // otherwise fine must keep rendering. Before the guard this threw and the
    // entire response surfaced as an error.
    const parts = await collect([
      envelope({ choices: [{ delta: { content: "A" } }] }),
      "data: {broken json\n\n",
      "data: not even json\n\n",
      envelope({ choices: [{ delta: { content: "B" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    expect(of(parts, "error")).toHaveLength(0);
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("AB");
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
  });
});

describe("doStream: thinking-tag extraction", () => {
  it("reassembles a thinking tag split across chunk boundaries", async () => {
    // Every boundary here is adversarial: the open tag, the close tag, and the
    // post-thinking blank line are each cut in half across deltas.
    const parts = await collect([
      envelope({ choices: [{ delta: { content: "Let me think. <thi" } }] }),
      envelope({ choices: [{ delta: { content: "nking>2+2=4</think" } }] }),
      envelope({ choices: [{ delta: { content: "ing>\n\nThe answer is 4." } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    // Prose before the tag, then the held-back text flushes when the tag opens.
    expect(of(parts, "text-start")).toHaveLength(2);
    const text = of(parts, "text-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(text).toBe("Let me think. The answer is 4.");
    const reasoning = of(parts, "reasoning-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(reasoning).toBe("2+2=4");
    expect(of(parts, "reasoning-start")).toHaveLength(1);
    expect(of(parts, "reasoning-end")).toHaveLength(1);
    // The trailing blank line after the close tag is consumed, not emitted.
    expect(text).not.toMatch(/\n\nThe answer/);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
  });

  it("handles the <think> tag variant", async () => {
    const parts = await collect([
      envelope({ choices: [{ delta: { content: "<think>quick</think>done" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    const reasoning = of(parts, "reasoning-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(reasoning).toBe("quick");
    const text = of(parts, "text-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(text).toBe("done");
  });

  it("streams reasoning_content directly without tag parsing", async () => {
    const parts = await collect([
      envelope({ choices: [{ delta: { reasoning_content: "step 1" } }] }),
      envelope({ choices: [{ delta: { content: "answer" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    // The reasoning block closes before the text block opens.
    const sequence = parts.map((part) => part.type);
    expect(sequence.indexOf("reasoning-end")).toBeLessThan(sequence.indexOf("text-start"));
    expect(
      of(parts, "reasoning-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("step 1");
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("answer");
  });
});

describe("doStream: tool-call state machine", () => {
  it("adopts a late upstream id and flushes buffered argument deltas", async () => {
    // Qoder's Kimi adapter delivers the id in a later chunk than the name.
    // The first two deltas arrive before any id exists: tool-input-start must
    // wait for the real id, buffer the deltas, then flush them under it.
    const parts = await collect([
      envelope({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "read_file", arguments: '{"pa' } }],
            },
          },
        ],
      }),
      envelope({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a.txt"}' } }] } },
        ],
      }),
      envelope({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_upstream_1" }] } }] }),
      envelope({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);

    const starts = of(parts, "tool-input-start");
    expect(starts).toEqual([
      { type: "tool-input-start", id: "call_upstream_1", toolName: "read_file" },
    ]);
    // Both deltas carry the real id, in order, after the start.
    const deltas = of(parts, "tool-input-delta");
    expect(deltas.map((part) => ("delta" in part ? part.delta : "")).join("")).toBe(
      '{"path": "a.txt"}',
    );
    expect(deltas.every((part) => "id" in part && part.id === "call_upstream_1")).toBe(true);
    expect(of(parts, "tool-input-end")).toEqual([
      { type: "tool-input-end", id: "call_upstream_1" },
    ]);
    expect(of(parts, "tool-call")).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_upstream_1",
        toolName: "read_file",
        input: '{"path": "a.txt"}',
      },
    ]);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
  });

  it("fabricates an id when upstream never provides one", async () => {
    const parts = await collect([
      envelope({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "ls", arguments: "{}" } }] } },
        ],
      }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    const start = of(parts, "tool-input-start")[0] as { id: string; toolName: string };
    // A UUID, not a passthrough -- but consistent across every part of the call.
    expect(start.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(start.toolName).toBe("ls");
    expect(of(parts, "tool-input-end")).toEqual([{ type: "tool-input-end", id: start.id }]);
    expect(of(parts, "tool-call")).toEqual([
      { type: "tool-call", toolCallId: start.id, toolName: "ls", input: "{}" },
    ]);
    // hasToolCalls overrides the raw "stop" reason.
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
  });

  it("completes a call as soon as the arguments parse, without waiting for stream end", async () => {
    const parts = await collect([
      envelope({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "{}" } }],
            },
          },
        ],
      }),
      envelope({ choices: [{ delta: { content: "after tools" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);

    const sequence = parts.map((part) => part.type);
    // The tool call closes before the post-tool text starts.
    expect(sequence.indexOf("tool-call")).toBeLessThan(sequence.indexOf("text-start"));
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("after tools");
  });

  it("keeps two parallel tool calls separate by index", async () => {
    const parts = await collect([
      envelope({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "ls", arguments: '{"x"' } },
                { index: 1, id: "call_b", function: { name: "cat", arguments: '{"y"' } },
              ],
            },
          },
        ],
      }),
      envelope({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ":1}" } },
                { index: 1, function: { arguments: ":2}" } },
              ],
            },
          },
        ],
      }),
      envelope({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);

    const calls = of(parts, "tool-call") as Array<{
      toolCallId: string;
      toolName: string;
      input: string;
    }>;
    expect(calls).toEqual([
      { type: "tool-call", toolCallId: "call_a", toolName: "ls", input: '{"x":1}' },
      { type: "tool-call", toolCallId: "call_b", toolName: "cat", input: '{"y":2}' },
    ]);
  });
});

describe("doGenerate", () => {
  it("aggregates the stream into content blocks", async () => {
    stubFetch([
      envelope({ choices: [{ delta: { content: "Hello" } }] }),
      envelope({ choices: [{ delta: { content: " world" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
    ]);
    const model = new QoderLanguageModel("auto", credentials);
    const result = await model.doGenerate(callOptions);

    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toMatchObject({ unified: "stop" });
    expect(result.warnings).toEqual([]);
  });
});
