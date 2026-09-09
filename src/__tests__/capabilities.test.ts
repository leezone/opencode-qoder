import { describe, expect, it } from "vitest";
import {
  capabilityError,
  formatUtc,
  renderAccount,
  renderAuth,
  renderCatalog,
  renderQuota,
  reportModel,
} from "../capabilities.js";
import { shapeQuota } from "../quota.js";

// Shapes lifted verbatim from live endpoints (verified 2026-09-08):
// quota answers camelCase with the org package's ceiling spelled `cap`, and a
// cap of -1 there means "no ceiling", not "zero allowed".
const quotaPayload = {
  userId: "019eb087-a310-7926-bace-277f98fac70d",
  userType: "teams",
  usageType: "credits",
  totalUsagePercentage: 0.01,
  isQuotaExceeded: false,
  expiresAt: 1791336225000,
  upgradeUrl: "https://qoder.com/pricing?client=qoder",
  userQuota: { total: 3000, used: 2, remaining: 2998, percentage: 0.01, unit: "credits" },
  orgResourcePackage: {
    used: 0,
    remaining: 5547,
    percentage: 0,
    unit: "credits",
    cap: -1,
    available: true,
  },
};

const accountPayload = {
  id: "019eb087-a310-7926-bace-277f98fac70d",
  name: "心怡 张",
  username: "a1a4d562",
  email: "user@example.com",
  organization_name: "天津能源科技",
  organization_id: "019e6838",
  created_at: "2026-06-10T07:55:39Z",
  source: "dashboard.email_pwd",
  is_highest_tier: false,
  avatar: "https://qoder.com/users/019eb087/default/avatars",
};

describe("formatUtc", () => {
  it("renders minute precision in UTC, independent of the machine timezone", () => {
    expect(formatUtc(0)).toBe("1970-01-01 00:00 UTC");
    expect(formatUtc(1791336225000)).toBe("2026-10-07 01:23 UTC");
  });

  it("says unknown rather than inventing a date from null", () => {
    expect(formatUtc(null)).toBe("unknown");
  });
});

describe("renderQuota", () => {
  it("reports each bucket separately and never calls a capped org package zero", () => {
    const text = renderQuota(shapeQuota(quotaPayload), accountPayload);
    expect(text).toContain("plan         2998 / 3000 left, 1.0% used");
    // cap -1 is a missing ceiling. Printing "5547 / -1" would read as a debt.
    expect(text).toContain("org package  5547 left, no ceiling set");
    expect(text).not.toContain("/ -1");
    expect(text).toContain("Total left: 8545");
    expect(text).toContain("Account:  心怡 张 <user@example.com>");
    expect(text).toContain("Org:      天津能源科技");
    expect(text).toContain("Renews:     2026-10-07 01:23 UTC");
    expect(text).toContain("Plan usage: 1.0% (plan bucket only)");
    expect(text).not.toContain("EXHAUSTED");
  });

  it("marks the report and quotes the upgrade url when credits are drained", () => {
    const drained = {
      ...quotaPayload,
      isQuotaExceeded: true,
      userQuota: { ...quotaPayload.userQuota, remaining: 0, percentage: 1 },
    };
    const text = renderQuota(shapeQuota(drained));
    expect(text).toContain("EXHAUSTED");
    expect(text).toContain("Upgrade:    https://qoder.com/pricing?client=qoder");
  });

  it("sums only the buckets that answered -- a missing add-on is not a zero", () => {
    const text = renderQuota(shapeQuota(quotaPayload));
    // 2998 + 5547; an absent addOnQuota contributes nothing and prints nothing.
    expect(text).not.toContain("add-on");
    expect(text).toContain("Total left: 8545");
  });

  it("still says how much is left when the identity lookup came back empty", () => {
    const text = renderQuota(shapeQuota(quotaPayload), {});
    expect(text).not.toContain("Account:");
    expect(text).toContain("Plan:     teams / credits");
    expect(text).toContain("Total left: 8545");
  });
});

describe("renderAccount", () => {
  it("renders the profile fields the endpoint actually returns", () => {
    const text = renderAccount(accountPayload, "cred-user", "teams");
    expect(text).toContain("Name          心怡 张");
    expect(text).toContain("Email         user@example.com");
    expect(text).toContain("Org           天津能源科技");
    expect(text).toContain("Highest tier  no");
  });

  it("keeps standing when userinfo is empty, and says what the credential knows", () => {
    const text = renderAccount({}, "cred-user", "");
    expect(text).toContain("Account info unavailable");
    expect(text).toContain("cred-user");
  });
});

describe("reportModel", () => {
  it("resolves a bundled id exactly and reports its limits", () => {
    const { output, data } = reportModel("auto");
    expect(output).toContain("Model auto");
    expect(output).not.toContain("not found");
    expect((data as { resolved: string }).resolved).toBe("auto");
  });

  it("never passes an unknown id off as a real hit", () => {
    const { output, data } = reportModel("no-such-model");
    expect(output).toContain("not found");
    expect(output).toContain("resolved to");
    expect((data as { resolved: string }).resolved).not.toBe("no-such-model");
  });
});

describe("renderCatalog", () => {
  it("shows provenance, the cache path and whether discovery is on", () => {
    const status = {
      source: "cache" as const,
      live: 17,
      total: 17,
      fetchedAt: 1791336225000,
      expiresAt: 1791336225000,
      lastError: "",
    };
    const text = renderCatalog(status);
    expect(text).toContain("source        cache");
    expect(text).toContain("bundled table 17 entries");
    expect(text).toContain("disk cache    ");
    expect(text).toContain("discovery     on");
  });

  it("surfaces the last error instead of hiding a failed refresh", () => {
    const status = {
      source: "fallback" as const,
      live: 0,
      total: 17,
      fetchedAt: 0,
      expiresAt: 0,
      lastError: "HTTP 503",
    };
    expect(renderCatalog(status)).toContain("last error    HTTP 503");
  });
});

describe("capabilityError", () => {
  it("returns the cause in the text, never a bare 'no data'", () => {
    const report = capabilityError("quota", new Error("HTTP 503 "));
    expect(report.output).toBe("qoder quota failed: HTTP 503");
    expect(report.data).toEqual({ error: "HTTP 503" });
  });

  it("survives a non-Error rejection", () => {
    expect(capabilityError("models", "boom").output).toContain("boom");
  });
});

describe("renderAuth", () => {
  const layers = [
    { layer: "apiKey option", shape: "pat" },
    // The longest layer name is 31 chars: exactly the trap where a fixed-width
    // pad silently loses its separating space.
    { layer: "env QODER_PERSONAL_ACCESS_TOKEN", shape: "absent" },
  ];

  it("keeps a column of space between the layer name and its shape", () => {
    const text = renderAuth(layers, null, "no credential");
    for (const line of text.split("\n")) {
      if (line.startsWith("  env QODER_PERSONAL_ACCESS_TOKEN")) {
        expect(line).toMatch(/^ {2}env QODER_PERSONAL_ACCESS_TOKEN\s+absent$/);
      }
    }
    expect(text).toContain("Not authenticated: no credential");
  });

  it("reports identity and the skew-adjusted deadline when a credential resolves", () => {
    const text = renderAuth(
      layers,
      { userID: "u1", email: "e@x", name: "N", machineID: "m1", expires: 1791336225000 - 300000 },
      "",
    );
    expect(text).toContain("Resolves to   N <e@x>");
    expect(text).toContain("Usable until  2026-10-07 01:23 UTC (skew 5m)");
    // A shape, never a value.
    expect(text).not.toContain("pt-");
  });
});
