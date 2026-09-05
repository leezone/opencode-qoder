import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QODER_QUOTA_URL } from "../constants.js";
import type { DiscoveredModel } from "../model-catalog.js";

// A quota response has to carry user_id AND user_type before it counts; see the
// guard in isQuotaExhausted(). Everything here builds on that valid envelope.
function quota(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { user_id: "u1", user_type: "individual", ...overrides };
}

// The catalog holds module-level state (quotaExhausted, liveModels, TTLs), so
// each case loads a fresh registry and stubs fetch to serve both endpoints.
async function loadCatalog(handlers: { models: unknown; quota?: unknown; quotaOk?: boolean }) {
  vi.resetModules();
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith(QODER_QUOTA_URL)) {
        return {
          ok: handlers.quotaOk ?? true,
          status: handlers.quotaOk === false ? 503 : 200,
          json: async () => handlers.quota,
          text: async () => "",
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => handlers.models,
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return { catalog: await import("../model-catalog.js"), urls };
}

// parseCatalog needs recognisable limits, so every fixture carries one.
const modelsFixture = {
  chat: [
    { key: "paid", display_name: "Paid", max_input_tokens: 180000, price_factor: 0.5 },
    { key: "free", display_name: "Free", max_input_tokens: 180000, price_factor: 0 },
    { key: "promo", display_name: "Promo", max_input_tokens: 180000, tags: ["limited_time_free"] },
    { key: "bare", display_name: "Bare", max_input_tokens: 180000 },
  ],
};

// A non-"pt-" token short-circuits resolveQoderCredentials(), so no credential
// exchange request is made and fetch is only hit for the two endpoints above.
const options = { apiKey: "test-token" };

let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "qoder-quota-"));
  // Keeps saveDiskCache() out of the real ~/.cache/opencode.
  process.env.QODER_MODEL_DISK_CACHE = join(cacheDir, "models.json");
  delete process.env.QODER_DISABLE_MODEL_DISCOVERY;
  delete process.env.QODER_MODEL_LIST_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.QODER_MODEL_DISK_CACHE;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("isQuotaExhausted", () => {
  it("reads the exceeded flag", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(catalog.isQuotaExhausted(quota({ is_quota_exceeded: true }))).toBe(true);
    expect(
      catalog.isQuotaExhausted(quota({ is_quota_exceeded: false, user_quota: { remaining: 5 } })),
    ).toBe(false);
  });

  it("accepts the camelCase spelling", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(
      catalog.isQuotaExhausted({ userId: "u1", userType: "individual", isQuotaExceeded: true }),
    ).toBe(true);
  });

  it("treats drained buckets as exhausted even when the flag says otherwise", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(
      catalog.isQuotaExhausted(
        quota({
          is_quota_exceeded: false,
          user_quota: { remaining: 0 },
          add_on_quota: { remaining: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("sums the add-on and shared buckets before concluding drained", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(
      catalog.isQuotaExhausted(
        quota({ user_quota: { remaining: 0 }, add_on_quota: { remaining: 3 } }),
      ),
    ).toBe(false);
    expect(
      catalog.isQuotaExhausted(
        quota({ user_quota: { remaining: 0 }, shared_quota: { remaining: 2 } }),
      ),
    ).toBe(false);
  });

  it("falls back to the usage percentage only when the flag is absent", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(
      catalog.isQuotaExhausted(
        quota({ total_usage_percentage: 100, user_quota: { remaining: 9 } }),
      ),
    ).toBe(true);
    // An explicit false outranks a full percentage bar, matching qodercli's
    // `flag ?? percentage >= 100`.
    expect(
      catalog.isQuotaExhausted(
        quota({
          is_quota_exceeded: false,
          total_usage_percentage: 100,
          user_quota: { remaining: 9 },
        }),
      ),
    ).toBe(false);
  });

  it("refuses to judge a payload that is not a quota response", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    // Without this guard an empty or reshaped body reads as "0 remaining" and
    // every paid model gets marked unavailable.
    expect(catalog.isQuotaExhausted({})).toBe(false);
    expect(catalog.isQuotaExhausted(null)).toBe(false);
    expect(catalog.isQuotaExhausted("exhausted")).toBe(false);
    expect(catalog.isQuotaExhausted({ user_id: "u1" })).toBe(false);
    expect(catalog.isQuotaExhausted({ user_type: "individual" })).toBe(false);
  });
});

describe("displayName", () => {
  const model = (overrides: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
    id: "paid",
    name: "Paid",
    contextWindow: 200000,
    inputWindow: 180000,
    maxTokens: 8000,
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    efforts: [],
    source: "system",
    origin: "qoder",
    limitsFromUpstream: true,
    ...overrides,
  });

  it("leaves the name alone when upstream advertised no multiplier", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(catalog.displayName(model())).toBe("Paid");
  });

  it("renders the multiplier compactly", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(catalog.displayName(model({ priceFactor: 0.5 }))).toBe("Paid (0.5x)");
    expect(catalog.displayName(model({ priceFactor: 1 }))).toBe("Paid (1x)");
    expect(catalog.displayName(model({ priceFactor: 0 }))).toBe("Paid (0x)");
    expect(catalog.displayName(model({ priceFactor: 1.25 }))).toBe("Paid (1.25x)");
  });

  it("lets the limited-time-free tag outrank the multiplier", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture });
    expect(catalog.displayName(model({ priceFactor: 0.5, tags: ["limited_time_free"] }))).toBe(
      "Paid (Free)",
    );
  });

  it("marks paid models unavailable once credits are drained", async () => {
    const { catalog } = await loadCatalog({
      models: modelsFixture,
      quota: quota({ is_quota_exceeded: true }),
    });
    await catalog.refreshModels(options, true);
    const byID = new Map(catalog.catalogModels().map((entry) => [entry.id, entry]));
    expect(catalog.displayName(byID.get("paid")!)).toBe("Paid (0.5x, Unavailable)");
    // Zero multiplier, free tag, and unknown price all stay usable.
    expect(catalog.displayName(byID.get("free")!)).toBe("Free (0x)");
    expect(catalog.displayName(byID.get("promo")!)).toBe("Promo (Free)");
  });

  it("keeps the model enabled -- the marker is a suffix, not a status change", async () => {
    const { catalog } = await loadCatalog({
      models: modelsFixture,
      quota: quota({ is_quota_exceeded: true }),
    });
    await catalog.refreshModels(options, true);
    const paid = catalog.catalogModels().find((entry) => entry.id === "paid")!;
    // A deprecated status would drop it from opencode's list entirely.
    expect(catalog.catalogModels().map((entry) => entry.id)).toContain("paid");
    expect(paid.priceFactor).toBe(0.5);
  });

  it("fails open when the quota endpoint is unreachable", async () => {
    const { catalog, urls } = await loadCatalog({ models: modelsFixture, quotaOk: false });
    await catalog.refreshModels(options, true);
    const paid = catalog.catalogModels().find((entry) => entry.id === "paid")!;
    expect(urls.some((url) => url.startsWith(QODER_QUOTA_URL))).toBe(true);
    expect(catalog.displayName(paid)).toBe("Paid (0.5x)");
  });

  it("does not let a quota failure break model discovery", async () => {
    const { catalog } = await loadCatalog({ models: modelsFixture, quotaOk: false });
    const status = await catalog.refreshModels(options, true);
    expect(status.source).toBe("qoder");
    expect(status.lastError).toBe("");
    expect(catalog.catalogModels().length).toBeGreaterThan(0);
  });

  it("changes the catalog signature when the quota state flips", async () => {
    const available = await loadCatalog({
      models: modelsFixture,
      quota: quota({ is_quota_exceeded: false, user_quota: { remaining: 10 } }),
    });
    await available.catalog.refreshModels(options, true);
    const availableSignature = available.catalog.catalogSignature();

    const exhausted = await loadCatalog({
      models: modelsFixture,
      quota: quota({ is_quota_exceeded: true }),
    });
    await exhausted.catalog.refreshModels(options, true);

    // Without this, opencode would keep rendering stale names after the flip.
    expect(exhausted.catalog.catalogSignature()).not.toBe(availableSignature);
  });
});
