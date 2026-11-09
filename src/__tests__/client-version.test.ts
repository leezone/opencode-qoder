import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// client-version.ts decides the `Cosy-Version` every request is signed with, and
// that value is a live server-side filter: the model list drops any entry whose
// `minimal_version.cli` is above it. Pinned to a literal 1.1.42 this plugin was
// silently missing the `fast` tier (minimal_version.cli 1.1.70). These tests pin
// the properties that keep that from coming back:
//
//   - a probe failure never downgrades or empties the value (requests keep
//     working behind a firewall),
//   - a registry answer never walks the version BELOW the shipped default (a
//     stale mirror must not re-close a gate),
//   - QODER_CLIENT_VERSION beats the probe entirely,
//   - the value is read at request time, so a probe landing mid-session applies.
//
// Every case loads a fresh module graph: the probe memoizes its result (and its
// in-flight promise) at module scope, exactly like model-catalog's catalog state.

const REGISTRY = "https://registry.npmjs.org/-/package/@qoder-ai/qodercli/dist-tags";
// The mirror is the latency/failure fallback (measured 66-198ms vs npmjs.com's
// 2-4s with intermittent "fetch failed" from CN).
const MIRROR = "https://registry.npmmirror.com/-/package/@qoder-ai/qodercli/dist-tags";

type Fetched = { url: string; headers: Record<string, string> };

// stubRegistry() serves one JSON body for the registry URL and records what was
// requested, so a case can assert both the answer handling and the wire shape.
function stubRegistry(options: { latest?: string; status?: number; throws?: boolean } = {}) {
  const fetched: Fetched[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      fetched.push({ url, headers: init?.headers ?? {} });
      if (options.throws) throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      return {
        ok: (options.status ?? 200) < 400,
        status: options.status ?? 200,
        json: async () => ({ beta: "1.1.54-beta.1", latest: options.latest }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return fetched;
}

async function load() {
  vi.resetModules();
  return import("../client-version.js");
}

describe("client version resolution", () => {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-client-version-"));
    process.env.XDG_CACHE_HOME = dir;
    delete process.env.QODER_CLIENT_VERSION;
    delete process.env.QODER_CLIENT_VERSION_CACHE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.QODER_CLIENT_VERSION;
    delete process.env.QODER_CLIENT_VERSION_CACHE;
  });

  it("starts on the shipped default without touching the network", async () => {
    const fetched = stubRegistry({ latest: "9.9.9" });
    const mod = await load();
    // resolveClientVersion() is the request-path call; it must answer from
    // memory, never from a probe, or the first request of a process would wait
    // on a registry round trip.
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
    expect(fetched).toHaveLength(0);
    expect(mod.describeClientVersion()).toContain("shipped default");
  });

  it("adopts the registry's latest version and reports where it came from", async () => {
    const fetched = stubRegistry({ latest: "1.1.86" });
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe("1.1.86");
    expect(mod.resolveClientVersion()).toBe("1.1.86");
    expect(mod.describeClientVersion()).toContain("remote");
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe(REGISTRY);
    // A public registry: no credential may ever ride this request.
    expect(fetched[0].headers.Authorization).toBeUndefined();
  });

  it("falls back to the mirror when the primary registry fails", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        // npmjs.com unreachable (a proxy, a CN network): the mirror must still
        // produce a version instead of the whole probe failing.
        if (url === REGISTRY) throw new Error("fetch failed");
        return {
          ok: true,
          status: 200,
          json: async () => ({ latest: "1.1.86" }),
          text: async () => "",
        } as unknown as Response;
      }),
    );
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe("1.1.86");
    expect(fetched).toEqual([REGISTRY, MIRROR]);
  });

  it("reports every registry that failed, not just the last", async () => {
    stubRegistry({ throws: true });
    const mod = await load();
    await mod.refreshClientVersion();
    const line = mod.describeClientVersion();
    // Both hosts named: otherwise "ENOTFOUND" alone cannot tell an operator
    // whether npmjs.com or the mirror is the blocked one.
    expect(line).toContain("registry.npmjs.org");
    expect(line).toContain("registry.npmmirror.com");
  });

  it("keeps the previous value when the probe fails, and logs why", async () => {
    stubRegistry({ throws: true });
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
    // The failure is surfaced in diagnostics instead of being swallowed, so
    // "why is my client version stale" is answerable from the tool output.
    expect(mod.describeClientVersion()).toContain("probe:");
    expect(mod.describeClientVersion()).toContain("ENOTFOUND");
  });

  it("keeps the previous value on a non-2xx registry answer", async () => {
    stubRegistry({ status: 503, latest: "1.1.99" });
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("ignores a malformed version rather than signing with garbage", async () => {
    // The value becomes a request header; the gateway's answer to a bad one is a
    // 4xx on every request, which is far worse than staying on the default.
    stubRegistry({ latest: "not-a-version" });
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("never walks below the shipped default when the registry is stale", async () => {
    // A mirror stuck on an old release must not re-close a model gate that this
    // plugin release already opens.
    stubRegistry({ latest: "1.0.1" });
    const mod = await load();
    expect(await mod.refreshClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("lets QODER_CLIENT_VERSION override the probe entirely", async () => {
    const fetched = stubRegistry({ latest: "1.1.86" });
    process.env.QODER_CLIENT_VERSION = "1.1.42";
    const mod = await load();
    expect(mod.resolveClientVersion()).toBe("1.1.42");
    await mod.refreshClientVersion();
    expect(mod.resolveClientVersion()).toBe("1.1.42");
    // No point probing for a value that will never be used.
    expect(fetched).toHaveLength(0);
    expect(mod.describeClientVersion()).toContain("env");
  });

  it("treats an implausible QODER_CLIENT_VERSION as absent", async () => {
    stubRegistry({ latest: "1.1.86" });
    process.env.QODER_CLIENT_VERSION = "../../etc/passwd";
    const mod = await load();
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("serves the persisted version on the next process start", async () => {
    stubRegistry({ latest: "1.1.90" });
    const first = await load();
    await first.refreshClientVersion();

    // Simulate a restart: fresh module graph, no network this time. The seed
    // path must not depend on a successful probe, or an offline start would
    // fall all the way back to the shipped value.
    vi.unstubAllGlobals();
    stubRegistry({ throws: true });
    const second = await load();
    expect(second.resolveClientVersion()).toBe("1.1.90");
  });

  it("throttles a repeated probe and skips the network inside the TTL", async () => {
    const fetched = stubRegistry({ latest: "1.1.86" });
    const mod = await load();
    await mod.refreshClientVersion();
    await mod.refreshClientVersion();
    expect(fetched).toHaveLength(1);
  });

  it("coalesces concurrent probes into one request", async () => {
    const fetched = stubRegistry({ latest: "1.1.86" });
    const mod = await load();
    const [a, b] = await Promise.all([mod.refreshClientVersion(), mod.refreshClientVersion()]);
    expect(a).toBe("1.1.86");
    expect(b).toBe("1.1.86");
    expect(fetched).toHaveLength(1);
  });

  it("honours the cache-path override and seeds from it", async () => {
    const path = join(dir as string, "pinned.json");
    // The override exists so an operator (or a test) can point this at a chosen
    // file instead of opencode's cache directory. The seeded value must be
    // ABOVE the shipped default to survive the downgrade guard.
    writeFileSync(path, JSON.stringify({ version_tag: 1, version: "1.2.0", source: "registry" }));
    process.env.QODER_CLIENT_VERSION_CACHE = path;
    const mod = await load();
    expect(mod.clientVersionCachePath()).toBe(path);
    expect(mod.resolveClientVersion()).toBe("1.2.0");
  });

  it("ignores a corrupt cache file", async () => {
    const path = join(dir as string, "broken.json");
    writeFileSync(path, "{not json");
    process.env.QODER_CLIENT_VERSION_CACHE = path;
    const mod = await load();
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("rejects a cache written by a different cache format", async () => {
    const path = join(dir as string, "future.json");
    // version_tag guards the file SHAPE. A record from a later release may hold
    // the version under a different key, so it must be ignored rather than
    // half-read into a wrong value.
    writeFileSync(path, JSON.stringify({ version_tag: 99, version: "9.9.9" }));
    process.env.QODER_CLIENT_VERSION_CACHE = path;
    const mod = await load();
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });

  it("rejects a cache entry below the shipped default", async () => {
    const path = join(dir as string, "old.json");
    writeFileSync(path, JSON.stringify({ version_tag: 1, version: "1.0.1" }));
    process.env.QODER_CLIENT_VERSION_CACHE = path;
    const mod = await load();
    // Same downgrade guard as the registry path: a cache written by an older
    // install must not re-close a model gate this release already opens. The
    // value is raised to the shipped default rather than discarded.
    expect(mod.resolveClientVersion()).toBe(mod.CLIENT_VERSION_FALLBACK);
  });
});
