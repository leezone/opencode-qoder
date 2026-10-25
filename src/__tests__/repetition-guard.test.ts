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
import { REPETITION_MARKER, RepetitionGuard, repetitionGuardEnabled } from "../repetition-guard.js";

// The repetition guard: unit tests for the periodic-tail detector, plus
// end-to-end doStream() tests (stubbed fetch, same harness as stream.test.ts)
// proving that a looping stream is truncated with a visible marker and a
// "repetition" finish reason instead of draining the output budget.

// A non-"pt-" token short-circuits resolveQoderCredentials(), so the tests
// never hit the token-exchange endpoint; fetch only serves the chat endpoint.
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

function textOf(parts: LanguageModelV3StreamPart[]): string {
  return of(parts, "text-delta")
    .map((part) => ("delta" in part ? part.delta : ""))
    .join("");
}

function reasoningOf(parts: LanguageModelV3StreamPart[]): string {
  return of(parts, "reasoning-delta")
    .map((part) => ("delta" in part ? part.delta : ""))
    .join("");
}

// 17 chars: a period of 17 needs 8 repeats and a >= 192-char span, so the
// 12th copy (204 chars) is the earliest trip point.
const LOOP_PHRASE = "抱歉，我无法直接协助完成这个操作。";

let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "qoder-repetition-"));
  // Keeps model-catalog's import-time disk-cache seed out of the real
  // ~/.cache/opencode, so the model definition lookup is hermetic.
  process.env.QODER_MODEL_DISK_CACHE = join(cacheDir, "models.json");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QODER_MODEL_DISK_CACHE;
  delete process.env.QODER_REPETITION_GUARD;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("RepetitionGuard", () => {
  it("stays quiet on ordinary text", () => {
    const guard = new RepetitionGuard();
    guard.feed("这是一段普通的中文说明文字，包含标点、数字 12345 和英文单词 guard。");
    guard.feed("随后是另一句不同的话，确保窗口的结尾不具备任何周期性。");
    expect(guard.tripped).toBe(false);
  });

  it("tolerates a phrase repeating a few times mid-text", () => {
    const guard = new RepetitionGuard();
    // Long enough lead-in to cross the minimum span, few enough repeats, and
    // a non-periodic close: none of the thresholds may fire.
    guard.feed(
      "开头需要足够长，让整段文本越过检测窗口的最小跨度要求，这样才能证明判定不是被窗口大小挡住的。".repeat(
        2,
      ),
    );
    guard.feed(LOOP_PHRASE.repeat(5));
    guard.feed("重复结束后的正常收尾，把尾部的周期性破坏掉。");
    expect(guard.tripped).toBe(false);
  });

  it("trips when the tail becomes a verbatim loop", () => {
    const guard = new RepetitionGuard();
    guard.feed("开头一句正常的话。");
    guard.feed(LOOP_PHRASE.repeat(13));
    expect(guard.tripped).toBe(true);
  });

  it("trips on english sentence loops", () => {
    const guard = new RepetitionGuard();
    guard.feed("Sorry, but I cannot help with that request. ".repeat(8));
    expect(guard.tripped).toBe(true);
  });

  it("never trips on decorative single-character runs", () => {
    const guard = new RepetitionGuard();
    guard.feed("前言。");
    guard.feed("-".repeat(600));
    expect(guard.tripped).toBe(false);
  });

  it("needs many repeats before very short periods count", () => {
    const guard = new RepetitionGuard();
    guard.feed("ab".repeat(80)); // 160 chars: below the minimum span
    expect(guard.tripped).toBe(false);
    guard.feed("ab".repeat(30)); // 220 chars: period 2 needs 100 repeats (200 chars)
    expect(guard.tripped).toBe(true);
  });

  it("ignores deltas after tripping", () => {
    const guard = new RepetitionGuard();
    guard.feed(LOOP_PHRASE.repeat(13));
    expect(guard.tripped).toBe(true);
    const seen = guard.charsSeen;
    guard.feed("更多的内容也不会被计入。");
    expect(guard.charsSeen).toBe(seen);
  });

  it("respects the disable switch", () => {
    process.env.QODER_REPETITION_GUARD = "0";
    expect(repetitionGuardEnabled()).toBe(false);
    process.env.QODER_REPETITION_GUARD = "off";
    expect(repetitionGuardEnabled()).toBe(false);
    process.env.QODER_REPETITION_GUARD = "false";
    expect(repetitionGuardEnabled()).toBe(false);
    delete process.env.QODER_REPETITION_GUARD;
    expect(repetitionGuardEnabled()).toBe(true);
  });
});

describe("doStream: repetition guard", () => {
  it("truncates a looping text stream with a marker and a repetition finish", async () => {
    const parts = await collect([
      envelope({ id: "resp-1", model: "m1", created: 1700000000 }),
      ...Array.from({ length: 15 }, () =>
        envelope({ choices: [{ delta: { content: LOOP_PHRASE } }] }),
      ),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    expect(of(parts, "error")).toHaveLength(0);
    // Trips on the 12th copy; the remaining upstream chunks are never read.
    expect(textOf(parts)).toBe(LOOP_PHRASE.repeat(12) + REPETITION_MARKER);
    // The loop is one block, the marker a second: both opened and closed.
    expect(of(parts, "text-start")).toHaveLength(2);
    expect(of(parts, "text-end")).toHaveLength(2);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "length", raw: "repetition" },
    });
  });

  it("truncates a looping reasoning stream the same way", async () => {
    const parts = await collect([
      envelope({ id: "resp-2", model: "m1", created: 1700000000 }),
      ...Array.from({ length: 15 }, () =>
        envelope({ choices: [{ delta: { reasoning_content: LOOP_PHRASE } }] }),
      ),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    expect(reasoningOf(parts)).toBe(LOOP_PHRASE.repeat(12));
    expect(textOf(parts)).toBe(REPETITION_MARKER);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "length", raw: "repetition" },
    });
  });

  it("leaves a healthy stream untouched", async () => {
    const parts = await collect([
      envelope({ id: "resp-3", model: "m1", created: 1700000000 }),
      envelope({ choices: [{ delta: { content: "正常回答的第一句。" } }] }),
      envelope({ choices: [{ delta: { content: "第二句内容不同，长度也不同。" } }] }),
      envelope({ choices: [{ delta: { content: "第三句收尾。" } }] }),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    expect(textOf(parts)).toBe("正常回答的第一句。第二句内容不同，长度也不同。第三句收尾。");
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
    });
  });

  it("can be disabled with QODER_REPETITION_GUARD=0", async () => {
    process.env.QODER_REPETITION_GUARD = "0";
    const parts = await collect([
      envelope({ id: "resp-4", model: "m1", created: 1700000000 }),
      ...Array.from({ length: 15 }, () =>
        envelope({ choices: [{ delta: { content: LOOP_PHRASE } }] }),
      ),
      envelope({ choices: [{ finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    expect(textOf(parts)).toBe(LOOP_PHRASE.repeat(15));
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
    });
  });
});
