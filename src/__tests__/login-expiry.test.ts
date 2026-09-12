import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeOAuthRefresh } from "../auth.js";
import {
  QODER_CHAT_URL,
  QODER_EXCHANGE_URL,
  QODER_REFRESH_URL,
  QODER_USERINFO_URL,
} from "../constants.js";
import { QoderLanguageModel } from "../language-model.js";

// Covers the "login expired" failure mode and its recovery: the identity that
// gets signed into a COSY payload, the one-shot replay when the gateway rejects
// a credential, and the session_id the upstream cache-affinity key is built
// from.
//
// These are wire-level tests on purpose. Every part of this story lives in what
// leaves the process -- a uid header, a session_id field, a second POST -- and
// none of it is visible in a unit test of the functions that produce it.

const prompt: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const callOptions = { prompt } as LanguageModelV3CallOptions;

// --- wire helpers -----------------------------------------------------------

// The chat body is sent qoderEncodeBody()'d. The transform is a base64 alphabet
// swap plus a rotation that is its own inverse (verified on the slice algebra:
// both directions are std[n-a:] + std[a:n-a] + std[:a]), so decoding is the same
// two steps in the other order. Inlined rather than exported from src/ because
// nothing at runtime ever needs to read a body we just wrote.
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeQoderBody(encoded: string): Record<string, unknown> {
  let std = "";
  for (const c of encoded) {
    if (c === "$") {
      std += "=";
      continue;
    }
    const idx = CUSTOM_ALPHABET.indexOf(c);
    std += idx >= 0 ? STD_ALPHABET[idx] : c;
  }
  const n = std.length;
  const a = Math.floor(n / 3);
  const b64 = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function envelope(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`;
}

// The chat endpoint reports a rejected credential as an HTTP 200 wrapping this
// envelope -- the shape that made this bug invisible to status-code handling.
function rejectionEnvelope(status: number, code: string, message: string): string {
  return `data: ${JSON.stringify({
    statusCodeValue: status,
    body: JSON.stringify({ code, message }),
  })}\n\n`;
}

const ANSWER = [
  envelope({ choices: [{ delta: { content: "hi" } }] }),
  envelope({ choices: [{ finish_reason: "stop" }] }),
  "data: [DONE]\n\n",
];

type Stub = {
  url: string;
  method: string;
  headers: Record<string, string>;
  text: string;
};

function jsonReply(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseReply(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

// Monotonic across the whole file: identityByToken memoizes by ACCESS token and
// is module state, so an exchange that handed back a previously-used token would
// inherit that token's identity and the test would read a leak as behaviour.
// Real job tokens are unique; the fixture has to be too.
let issuedTokens = 0;

/**
 * Routes every fetch by URL and records what went out. `chat` is a queue of
 * per-attempt responses so a test can say "reject, then answer".
 */
function stubNetwork(opts: {
  chat: string[][];
  userInfo?: unknown;
  jobToken?: (n: number) => string;
  refreshTokenReply?: unknown;
}): { calls: Stub[]; count: (url: string) => number } {
  const calls: Stub[] = [];
  let chatAttempts = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const raw = init?.body;
      const call: Stub = {
        url,
        method: String(init?.method ?? "GET"),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        text: Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? ""),
      };
      calls.push(call);

      if (url === QODER_EXCHANGE_URL) {
        issuedTokens += 1;
        return jsonReply({
          token: opts.jobToken?.(issuedTokens) ?? `job-token-${issuedTokens}`,
          refresh_token: "job-refresh",
          expires_in: 3600,
        });
      }
      if (url === QODER_USERINFO_URL) {
        return jsonReply(opts.userInfo ?? {});
      }
      if (url === QODER_REFRESH_URL) {
        return opts.refreshTokenReply === undefined
          ? new Response("not configured", { status: 500 })
          : jsonReply(opts.refreshTokenReply);
      }
      if (url === QODER_CHAT_URL) {
        const lines = opts.chat[Math.min(chatAttempts, opts.chat.length - 1)];
        chatAttempts += 1;
        return sseReply(lines);
      }
      return new Response(`unexpected fetch: ${call.method} ${url}`, { status: 500 });
    }),
  );

  return { calls, count: (url: string) => calls.filter((c) => c.url === url).length };
}

async function run(model: QoderLanguageModel): Promise<LanguageModelV3StreamPart[]> {
  const result = await model.doStream(callOptions);
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

function chatCalls(calls: Stub[]): Stub[] {
  return calls.filter((c) => c.url === QODER_CHAT_URL);
}

function errorMessageOf(parts: LanguageModelV3StreamPart[]): string {
  const errored = parts.find((p) => p.type === "error");
  if (errored?.type !== "error") return "";
  return errored.error instanceof Error ? errored.error.message : String(errored.error);
}

let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "qoder-expiry-"));
  process.env.QODER_MODEL_DISK_CACHE = join(cacheDir, "models.json");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QODER_MODEL_DISK_CACHE;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("signed identity", () => {
  // The gateway answers 105 to a COSY payload whose uid is the display
  // placeholder, so the real account id has to reach the wire.
  it("signs the account uid the exchange resolved, and looks it up once", async () => {
    const net = stubNetwork({
      chat: [ANSWER],
      userInfo: { id: "uid-real-777", email: "lee@example.com", name: "Lee" },
    });
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-identity-1" });

    const parts = await run(model);
    expect(parts.some((p) => p.type === "text-delta")).toBe(true);

    const chat = chatCalls(net.calls);
    expect(chat).toHaveLength(1);
    expect(chat[0].headers["Cosy-User"]).toBe("uid-real-777");
    expect(chat[0].headers.Authorization).toContain("Bearer COSY.");

    // A second turn reuses the credential, so neither the exchange, the
    // identity lookup, nor a re-sign should repeat per turn.
    await run(model);
    expect(net.count(QODER_EXCHANGE_URL)).toBe(1);
    expect(net.count(QODER_USERINFO_URL)).toBe(1);
    expect(chatCalls(net.calls)[1].headers["Cosy-User"]).toBe("uid-real-777");
  });

  // The model list accepts a placeholder uid while chat rejects it, so an
  // unresolved identity must degrade to the placeholder rather than throw --
  // signingUserID()'s whole reason to exist.
  it("falls back to the placeholder uid when userinfo resolves nothing", async () => {
    const net = stubNetwork({ chat: [ANSWER], userInfo: {} });
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-identity-2" });

    await expect(run(model)).resolves.toBeTruthy();
    expect(chatCalls(net.calls)[0].headers["Cosy-User"]).toBe("qoder-user");
  });

  it("re-resolves a uid stored as the legacy display placeholder", async () => {
    const net = stubNetwork({
      chat: [ANSWER],
      userInfo: { id: "uid-from-userinfo" },
    });
    // A connection written by an older version persisted the placeholder as its
    // uid; that has to count as unresolved, not as a real id.
    const model = new QoderLanguageModel("auto", {
      apiKey: "passthrough-token-a",
      qoderUserID: "qoder-user",
    });

    await run(model);
    expect(chatCalls(net.calls)[0].headers["Cosy-User"]).toBe("uid-from-userinfo");
  });
});

describe("105 recovery", () => {
  it("re-exchanges the PAT and replays the request once", async () => {
    const net = stubNetwork({
      chat: [[rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"], ANSWER],
      userInfo: { id: "uid-pat-9" },
    });
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-retry-1" });

    const parts = await run(model);

    const chat = chatCalls(net.calls);
    expect(chat).toHaveLength(2);
    // The replay must not reuse the rejected credential.
    expect(chat[1].headers["Cosy-User"]).toBe(chat[0].headers["Cosy-User"]);
    expect(chat[1].headers.Authorization).not.toBe(chat[0].headers.Authorization);
    expect(net.count(QODER_EXCHANGE_URL)).toBe(2);

    // The consumer sees one clean answer: no error part, and exactly one finish.
    expect(errorMessageOf(parts)).toBe("");
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(1);
    // The rejected attempt's parts are gone entirely -- not just its error.
    expect(parts[0].type).toBe("stream-start");
  });

  it("stops replaying after a second rejection", async () => {
    const net = stubNetwork({
      chat: [
        [rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"],
        [rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"],
        [rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"],
      ],
      userInfo: { id: "uid-pat-loop" },
    });
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-retry-loop" });

    const parts = await run(model);

    // One replay, never a loop: a renewed credential that is also rejected means
    // the credential was not the problem.
    expect(chatCalls(net.calls)).toHaveLength(2);
    expect(errorMessageOf(parts)).toContain("Login expired");
  });

  it("never replays once content reached the consumer", async () => {
    const net = stubNetwork({
      chat: [
        [
          envelope({ choices: [{ delta: { content: "partial" } }] }),
          rejectionEnvelope(403, "105", "Login expired"),
        ],
      ],
      userInfo: { id: "uid-pat-partial" },
    });
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-retry-partial" });

    const parts = await run(model);

    // A replay would append a second answer to a half-written assistant message.
    expect(chatCalls(net.calls)).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(1);
    expect(errorMessageOf(parts)).toContain("Login expired");
  });

  // An HTTP-level 401 is the same failure as the in-band envelope, and needs
  // the same recovery. It arrives before any stream exists, so it is retried at
  // a different site than the in-band case -- this pins that both work.
  it("recovers from an HTTP-level 401 the same way", async () => {
    const chat: string[][] = [ANSWER];
    const net = stubNetwork({ chat, userInfo: { id: "uid-http-401" } });
    let rejectionsLeft = 1;
    const inner = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input) === QODER_CHAT_URL && rejectionsLeft > 0) {
          rejectionsLeft -= 1;
          return new Response('{"code":"105","message":"Login expired"}', { status: 401 });
        }
        return inner(input as never, init as never);
      }),
    );
    const model = new QoderLanguageModel("auto", { personalAccessToken: "pt-http-401" });

    const parts = await run(model);
    expect(parts.some((p) => p.type === "text-delta")).toBe(true);
    expect(net.count(QODER_EXCHANGE_URL)).toBe(2);
  });
});

describe("credential renewal for a device-flow token", () => {
  // opencode's plugin API has no refreshToken hook (pi's does), so the request
  // path calls the endpoint itself.
  it("posts the refresh token to the center endpoint and replays with the new one", async () => {
    const net = stubNetwork({
      chat: [[rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"], ANSWER],
      userInfo: { id: "uid-oauth-3" },
      refreshTokenReply: {
        token: "job-token-refreshed",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      },
    });
    const model = new QoderLanguageModel("auto", {
      apiKey: "stale-job-token",
      refreshToken: encodeOAuthRefresh("device-refresh-1", "uid-oauth-3", "machine-1"),
    });

    const parts = await run(model);
    expect(parts.some((p) => p.type === "text-delta")).toBe(true);

    const refreshes = net.calls.filter((c) => c.url === QODER_REFRESH_URL);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].method).toBe("POST");
    expect(JSON.parse(refreshes[0].text)).toEqual({ refreshToken: "device-refresh-1" });
    expect(refreshes[0].headers.Authorization).toBe("Bearer stale-job-token");

    const chat = chatCalls(net.calls);
    expect(chat).toHaveLength(2);
    // The replay signs with the token the refresh endpoint handed back.
    expect(chat[1].headers["Cosy-User"]).toBe("uid-oauth-3");
    expect(chat[1].headers.Authorization).not.toBe(chat[0].headers.Authorization);
  });

  it("surfaces the placeholder diagnosis when there is nothing to renew", async () => {
    // A bare passthrough token carries no refresh field, and userinfo resolves
    // nothing -- the exact state that produces a 105 with no way out.
    const net = stubNetwork({
      chat: [[rejectionEnvelope(403, "105", "Login expired"), "data: [DONE]\n\n"]],
      userInfo: {},
    });
    const model = new QoderLanguageModel("auto", { apiKey: "bare-token-no-refresh" });

    const parts = await run(model);

    expect(chatCalls(net.calls)).toHaveLength(1);
    expect(net.count(QODER_REFRESH_URL)).toBe(0);
    const message = errorMessageOf(parts);
    expect(message).toContain("Login expired");
    // Names the actual cause, which the upstream message does not.
    expect(message).toMatch(/uid/i);
    expect(message).toMatch(/\/connect qoder|QODER_PERSONAL_ACCESS_TOKEN/);
  });
});

describe("session_id", () => {
  // Upstream keys prompt-cache state on session_id. Both reference clients send
  // a stable prefix plus a per-conversation part: stable within a conversation
  // (cache hits), distinct across them (no cross-talk).
  it("is stable within one opencode session and distinct across sessions", async () => {
    const net = stubNetwork({ chat: [ANSWER, ANSWER, ANSWER], userInfo: { id: "uid-sess" } });
    const model = new QoderLanguageModel("auto", { apiKey: "sess-token-1" });

    const withSession = (id: string): LanguageModelV3CallOptions =>
      ({ prompt, headers: { "x-session-id": id } }) as LanguageModelV3CallOptions;

    await run(model);
    await run(model);
    await model.doStream(withSession("ses_alpha"));
    await model.doStream(withSession("ses_alpha"));
    await model.doStream(withSession("ses_beta"));

    const seen = chatCalls(net.calls).map((c) => decodeQoderBody(c.text).session_id as string);
    expect(seen).toHaveLength(5);

    const [noHeaderA, noHeaderB, alphaA, alphaB, beta] = seen;
    // No session header: two requests from one library caller still differ, so
    // the old process-wide constant can never come back.
    expect(noHeaderA).not.toBe(noHeaderB);
    // Same conversation: the affinity the field exists for.
    expect(alphaA).toBe(alphaB);
    expect(alphaA).not.toBe(beta);
    // Stable prefix + conversation id.
    expect(alphaA).toMatch(/^[0-9a-f]{16}-ses_alpha$/);
  });
});
