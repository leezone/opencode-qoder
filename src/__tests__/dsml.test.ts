import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectToolNames, MarkupRepair } from "../dsml.js";
import { QoderLanguageModel } from "../language-model.js";

// The DSML markup-repair layer: unit tests for the state machine, plus
// end-to-end tests through QoderLanguageModel.doStream() with a stubbed fetch
// (markup inside content deltas must come out as tool-call parts, and a real
// structured tool_call must permanently retire the repair).

const OPEN = "<｜｜DSML｜｜ calls>";
const CLOSE = "</｜｜DSML｜｜ calls>";

function block(name: string, params: Record<string, string>, marks: Record<string, boolean> = {}) {
  const inner = Object.entries(params)
    .map(
      ([key, value]) =>
        `<｜｜DSML｜｜ parameter name="${key}"${marks[key] ? ' string="true"' : ""}>${value}</｜｜DSML｜｜ parameter>`,
    )
    .join("");
  return `${OPEN}<｜｜DSML｜｜ invoke name="${name}">${inner}</｜｜DSML｜｜ invoke>${CLOSE}`;
}

/** Feeds text in `chunkSizes`-sized deltas; returns text + converted calls. */
function runSplit(repair: MarkupRepair, text: string, chunkSizes: number[]) {
  let out = "";
  const calls: Array<{ name: string; arguments: string }> = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const size = chunkSizes[k % chunkSizes.length] ?? 1;
    const fed = repair.feed(text.slice(i, i + size));
    i += size;
    k += 1;
    out += fed.text;
    calls.push(...fed.calls);
  }
  out += repair.flush();
  return { out, calls };
}

describe("MarkupRepair: state machine", () => {
  it("passes clean text through untouched", () => {
    const repair = new MarkupRepair(new Set(["read_file"]), false);
    const { out, calls } = runSplit(repair, "just answer text, no markup", [7]);
    expect(out).toBe("just answer text, no markup");
    expect(calls).toHaveLength(0);
    expect(repair.seen).toBe(0);
  });

  it("converts a complete block into a call, keeping surrounding text", () => {
    const repair = new MarkupRepair(new Set(["read_file"]), false);
    const { out, calls } = runSplit(
      repair,
      `before ${block("read_file", { path: "src/main.ts" })} after`,
      [5],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("read_file");
    expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ path: "src/main.ts" });
    expect(out).toBe("before  after");
    expect(repair.converted).toBe(1);
    expect(repair.rejected).toBe(0);
  });

  it("is invariant to delta chunking (the opener straddles boundaries)", () => {
    const text = `a ${block("bash", { cmd: "ls -la" })} b`;
    for (const sizes of [[1], [2], [3], [1, 7, 2], [13]]) {
      const repair = new MarkupRepair(new Set(["bash"]), false);
      const { out, calls } = runSplit(repair, text, sizes);
      expect(out, `sizes=${sizes.join(",")}`).toBe("a  b");
      expect(calls, `sizes=${sizes.join(",")}`).toHaveLength(1);
      expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ cmd: "ls -la" });
    }
  });

  it("converts multiple blocks in order and keeps prose between them", () => {
    const repair = new MarkupRepair(new Set(["bash", "read_file"]), false);
    const { out, calls } = runSplit(
      repair,
      `${block("bash", { cmd: "pwd" })} mid ${block("read_file", { path: "a" })}`,
      [4],
    );
    expect(calls.map((call) => call.name)).toEqual(["bash", "read_file"]);
    expect(out).toBe(" mid ");
  });

  it("keeps an oversized unterminated block as prose (round-trip identity)", () => {
    const repair = new MarkupRepair(new Set(["bash"]), false);
    const runaway = `${OPEN}<｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="args">${"x".repeat(300 * 1024)}`;
    const { out, calls } = runSplit(repair, runaway, [4096]);
    expect(calls).toHaveLength(0);
    expect(out).toBe(runaway);
  });

  it("retire() hands back held bytes and goes permanently inert", () => {
    const repair = new MarkupRepair(new Set(["bash"]), false);
    repair.feed(`text ${OPEN.slice(0, 8)}`);
    expect(repair.retire()).toBe(OPEN.slice(0, 8));
    const fed = repair.feed(`${OPEN}${block("bash", { cmd: "x" })}`);
    expect(fed.calls).toHaveLength(0);
    expect(fed.text).toContain(OPEN);
    expect(repair.enabled).toBe(false);
  });

  it("rejects foreign tool names when allowUnknown=false, byte-exact", () => {
    const repair = new MarkupRepair(new Set(["read_file"]), false);
    const foreign = block("bash", { cmd: "x" });
    const { out, calls } = runSplit(repair, foreign, [6]);
    expect(calls).toHaveLength(0);
    expect(out).toBe(foreign);
    expect(repair.rejected).toBe(1);
  });

  it("accepts unknown names when allowUnknown=true", () => {
    const repair = new MarkupRepair(new Set([]), true);
    const { calls } = runSplit(repair, block("mystery_tool", { a: "1" }), [3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("mystery_tool");
  });

  it("keeps string-marked parameters as strings", () => {
    const repair = new MarkupRepair(new Set(["write"]), false);
    const { calls } = runSplit(repair, block("write", { content: "123" }, { content: true }), [9]);
    expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ content: "123" });
  });
});

describe("collectToolNames", () => {
  it("collects from tools[] (both shapes) and history tool_calls; junk ignored", () => {
    const names = collectToolNames({
      tools: [{ function: { name: "alpha" } }, { name: "beta" }, { function: {} }, null, "junk"],
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "gamma" } }, null] },
        { role: "user", content: "hi" },
        null,
      ],
    });
    expect([...names].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns an empty set for junk bodies without throwing", () => {
    expect(collectToolNames({}).size).toBe(0);
    expect(collectToolNames({ tools: "junk", messages: 5 }).size).toBe(0);
  });
});

// --- end-to-end through doStream ---------------------------------------------

const credentials = { apiKey: "test-job-token" };
const prompt: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const callOptions = { prompt } as LanguageModelV3CallOptions;

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

async function collect(lines: string[]): Promise<LanguageModelV3StreamPart[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(lines)),
  );
  const model = new QoderLanguageModel("auto", credentials);
  const result = await model.doStream(callOptions);
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

function of(parts: LanguageModelV3StreamPart[], type: LanguageModelV3StreamPart["type"]) {
  return parts.filter((part) => part.type === type);
}

// The repair allowlist comes from the outbound body's tools[]; these
// integration tests deliberately run WITHOUT declared tools, so the weak gate
// (identifier-shaped names, perfectly closed blocks) is what admits the call.

describe("doStream: DSML markup repair", () => {
  let cacheDir = "";

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "qoder-dsml-"));
    process.env.QODER_MODEL_DISK_CACHE = join(cacheDir, "models.json");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.QODER_MODEL_DISK_CACHE;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("restores a markup call carried in content as a tool-call part", async () => {
    // Split adversarially: the opener and closer each straddle a delta.
    const parts = await collect([
      envelope({
        choices: [
          { delta: { content: "Checking. <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=" } },
        ],
      }),
      envelope({
        choices: [
          { delta: { content: `"get_weather"><｜｜DSML｜｜ parameter name="city">Shanghai` } },
        ],
      }),
      envelope({
        choices: [
          {
            delta: {
              content: `</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`,
            },
          },
        ],
      }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    const calls = of(parts, "tool-call") as Array<{
      toolCallId: string;
      toolName: string;
      input: string;
    }>;
    expect(calls).toEqual([
      {
        type: "tool-call",
        toolCallId: expect.any(String),
        toolName: "get_weather",
        input: '{"city":"Shanghai"}',
      },
    ]);
    // The markup itself never leaks into text.
    const text = of(parts, "text-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(text).toBe("Checking. ");
    expect(text).not.toContain("DSML");
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
  });

  it("retires the repair when a structured tool_call arrives, held bytes return as text", async () => {
    const held = OPEN.slice(0, 6);
    const parts = await collect([
      envelope({ choices: [{ delta: { content: `text ${held}` } }] }),
      envelope({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_real", function: { name: "get_weather", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
      envelope({ choices: [{ delta: { content: markupText() } }] }),
      envelope({ choices: [{ finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);

    // The partial opener comes back verbatim as text, not swallowed.
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toContain(held);
    // Exactly ONE call -- the structured one; the post-retire markup stays text.
    const calls = of(parts, "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: "call_real", toolName: "get_weather" });
    const after = of(parts, "text-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(after).toContain("DSML");
  });

  it("flushes an undecided tail at stream end without dropping bytes", async () => {
    const tail = `${OPEN}<｜｜DSML｜｜ invoke name="get_weather">`; // never closes
    const parts = await collect([
      envelope({ choices: [{ delta: { content: `prefix ${tail}` } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const text = of(parts, "text-delta")
      .map((part) => ("delta" in part ? part.delta : ""))
      .join("");
    expect(text).toBe(`prefix ${tail}`);
    expect(of(parts, "tool-call")).toHaveLength(0);
  });

  it("leaves plain text byte-identical (repair never touches clean streams)", async () => {
    const parts = await collect([
      envelope({ choices: [{ delta: { content: "Hello world" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(
      of(parts, "text-delta")
        .map((part) => ("delta" in part ? part.delta : ""))
        .join(""),
    ).toBe("Hello world");
    expect(of(parts, "tool-call")).toHaveLength(0);
  });
});

function markupText(): string {
  return block("get_weather", { city: "Beijing" });
}
