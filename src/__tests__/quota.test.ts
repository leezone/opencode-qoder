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

// The catalog and quota modules hold module-level state (quotaExhausted,
// liveModels, TTLs), so each case loads a fresh registry and stubs fetch to
// serve both endpoints. Both modules are imported together so they share the
// same fresh instance graph (model-catalog itself imports quota). The binding
// is named quotaModule so it never shadows the quota() payload helper above.
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
  return {
    catalog: await import("../model-catalog.js"),
    quotaModule: await import("../quota.js"),
    urls,
  };
}

// parseCatalog needs recognisable limits, so every fixture carries one.
// Mirrors the live payload: two x0 models, and Qwen3.8-Max which advertises
// is_free true while still billing 0.5x.
const modelsFixture = {
  chat: [
    {
      key: "paid",
      display_name: "Paid",
      max_input_tokens: 180000,
      price_factor: 0.5,
      is_free: true,
    },
    { key: "free", display_name: "Free", max_input_tokens: 180000, price_factor: 0 },
    {
      key: "efficient",
      display_name: "Efficient",
      max_input_tokens: 180000,
      price_factor: 0,
      original_price_factor: 0.3,
      is_free: true,
    },
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
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    expect(quotaModule.isQuotaExhausted(quota({ is_quota_exceeded: true }))).toBe(true);
    expect(
      quotaModule.isQuotaExhausted(
        quota({ is_quota_exceeded: false, user_quota: { remaining: 5 } }),
      ),
    ).toBe(false);
  });

  it("accepts the camelCase spelling", async () => {
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    expect(
      quotaModule.isQuotaExhausted({ userId: "u1", userType: "individual", isQuotaExceeded: true }),
    ).toBe(true);
  });

  it("treats drained buckets as exhausted even when the flag says otherwise", async () => {
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    expect(
      quotaModule.isQuotaExhausted(
        quota({
          is_quota_exceeded: false,
          user_quota: { remaining: 0 },
          add_on_quota: { remaining: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("sums the add-on and shared buckets before concluding drained", async () => {
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    expect(
      quotaModule.isQuotaExhausted(
        quota({ user_quota: { remaining: 0 }, add_on_quota: { remaining: 3 } }),
      ),
    ).toBe(false);
    expect(
      quotaModule.isQuotaExhausted(
        quota({ user_quota: { remaining: 0 }, shared_quota: { remaining: 2 } }),
      ),
    ).toBe(false);
  });

  it("ignores the usage percentage, which is fractional and plan-only", async () => {
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    // Observed live: totalUsagePercentage 1 (== 100%, not 1%) with userQuota
    // drained to 0, yet orgResourcePackage still held 229 and isQuotaExceeded
    // was false. Treating the percentage as exhaustion would mislabel an
    // account that can still draw on its org package.
    expect(
      quotaModule.isQuotaExhausted(
        quota({
          totalUsagePercentage: 1,
          isQuotaExceeded: false,
          userQuota: { total: 3000, used: 3000, remaining: 0 },
          orgResourcePackage: { used: 1771, remaining: 229, cap: 2000 },
        }),
      ),
    ).toBe(false);
    // And with the flag absent it still decides on remaining, not percentage.
    expect(
      quotaModule.isQuotaExhausted(
        quota({
          totalUsagePercentage: 1,
          userQuota: { remaining: 0 },
          orgResourcePackage: { remaining: 229 },
        }),
      ),
    ).toBe(false);
  });

  it("refuses to judge a payload that is not a quota response", async () => {
    const { quotaModule } = await loadCatalog({ models: modelsFixture });
    // Without this guard an empty or reshaped body reads as "0 remaining" and
    // every paid model gets marked unavailable.
    expect(quotaModule.isQuotaExhausted({})).toBe(false);
    expect(quotaModule.isQuotaExhausted(null)).toBe(false);
    expect(quotaModule.isQuotaExhausted("exhausted")).toBe(false);
    expect(quotaModule.isQuotaExhausted({ user_id: "u1" })).toBe(false);
    expect(quotaModule.isQuotaExhausted({ user_type: "individual" })).toBe(false);
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

  it("marks paid models unavailable once credits are drained", async () => {
    const { catalog } = await loadCatalog({
      models: modelsFixture,
      quota: quota({ is_quota_exceeded: true }),
    });
    await catalog.refreshModels(options, true);
    const byID = new Map(catalog.catalogModels().map((entry) => [entry.id, entry]));
    // `paid` advertises is_free true alongside price_factor 0.5, as Qwen3.8-Max
    // does live. It bills, so it must be marked -- trusting is_free would leave
    // a paid model looking usable after the credits are gone.
    expect(catalog.displayName(byID.get("paid")!)).toBe("Paid (0.5x, Unavailable)");
    // x0 models stay selectable.
    expect(catalog.displayName(byID.get("free")!)).toBe("Free (0x)");
    expect(catalog.displayName(byID.get("efficient")!)).toBe("Efficient (0x)");
    // No advertised price is not evidence of being free. Every live entry
    // carries price_factor, so this is the bundled-fallback case, whose models
    // are all paid tiers -- marking them is correct.
    expect(catalog.displayName(byID.get("bare")!)).toBe("Bare (Unavailable)");
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
