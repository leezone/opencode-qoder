import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimDisabled, classifyStatus, shapeCampaignList, shapeClaimResult } from "../claim.js";

// The promotional campaign surface is a LEAF: nothing on the model, chat,
// catalog or quota path may reach into claim.ts, so the activity can be pulled
// offline (delete the file + its index.ts wiring) without disturbing the
// provider. That guarantee is only real if a build fails when it breaks -- this
// file is that tripwire, and the reason the module comments can promise it.

describe("claim isolation", () => {
  it("is imported by no src module other than index.ts", () => {
    // The leaf rule: the only allowed importer is index.ts's tool table. A
    // second one means something on the model path now depends on a promo, and
    // the "pull it offline safely" promise is gone.
    const importers: string[] = [];
    for (const entry of readdirSync(join(import.meta.dirname, ".."), {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name === "claim.ts") continue; // the leaf does not import itself
      const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
      if (/from\s+["']\.\/claim\.js["']/.test(source)) importers.push(entry.name);
    }
    expect(importers).toEqual(["index.ts"]);
  });
});

describe("claimDisabled", () => {
  const KEY = "OPENCODE_QODER_CLAIM";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("treats every documented off-value as off, case-insensitively", () => {
    for (const value of ["0", "off", "false", "none", "disable", "disabled", "OFF"]) {
      process.env[KEY] = value;
      expect(claimDisabled()).toBe(true);
    }
  });

  it("leaves the surface on for anything else, including unset", () => {
    delete process.env[KEY];
    expect(claimDisabled()).toBe(false);
    process.env[KEY] = "on";
    expect(claimDisabled()).toBe(false);
  });
});

describe("classifyStatus", () => {
  it("maps a gone endpoint to the long cooldown so a withdrawn promo stops nagging", () => {
    expect(classifyStatus(404)).toMatchObject({
      outcome: "OFFLINE",
      cooldownMs: 6 * 60 * 60 * 1000,
    });
    expect(classifyStatus(410).outcome).toBe("OFFLINE");
  });

  it("maps a transient 5xx to the short cooldown, not the offline one", () => {
    expect(classifyStatus(503)).toMatchObject({
      outcome: "SERVICE_UNAVAILABLE",
      cooldownMs: 45 * 60 * 1000,
    });
  });

  it("reads 409 as a closed window, not a broken service", () => {
    expect(classifyStatus(409).outcome).toBe("WINDOW_CLOSED");
  });

  it("treats an auth rejection as not-eligible with no cooldown", () => {
    // A 401 here means "this session cannot see the promo", not an outage; a
    // global cooldown would hide it from every other account in an --all sweep.
    const verdict = classifyStatus(401);
    expect(verdict.outcome).toBe("NOT_ELIGIBLE");
    expect(verdict.cooldownMs).toBe(0);
  });
});

describe("shapeCampaignList", () => {
  it("calls a hidden campaign offline without alarming", () => {
    const list = shapeCampaignList({ showCampaign: false, campaigns: [] });
    expect(list.offline).toBe(true);
    expect(list.reason).toBe("hidden for this account");
  });

  it("maps a real claimable campaign's fields", () => {
    const endAt = Math.floor(Date.now() / 1000) + 3600;
    const list = shapeCampaignList({
      uid: "u1",
      showCampaign: true,
      claimable: true,
      campaigns: [
        {
          campaignId: "c-1",
          campaignKey: "daily_checkin",
          claimStatus: "claimable",
          startAt: endAt - 7200,
          endAt,
          benefit: {
            kind: "CREDITS",
            amount: "100",
            modelScope: { modelSeries: { key: "C_S_U" } },
            validity: { fixedEnd: "2026-12-31T00:00:00Z" },
          },
          placements: [{ content: { zh: { title: "签到", description: "每日" } } }],
        },
      ],
    });
    expect(list.offline).toBe(false);
    expect(list.claimable).toBe(true);
    expect(list.userID).toBe("u1");
    const [campaign] = list.campaigns;
    expect(campaign.id).toBe("c-1");
    // Lowercase from the wire still lands in the known-status vocabulary.
    expect(campaign.status).toBe("CLAIMABLE");
    expect(campaign.benefit?.amount).toBe(100);
    expect(campaign.benefit?.scope).toBe("C_S_U");
    expect(campaign.title).toBe("签到");
  });

  it("keeps an unknown status visible rather than treating it as claimable", () => {
    // Defensive default: a field we have not been taught is reported as itself
    // and never claimed on. The sweep acts only on CLAIMABLE, so a mis-parse
    // must not turn into a spontaneous POST.
    const list = shapeCampaignList({
      showCampaign: true,
      campaigns: [{ campaignId: "c-2", claimStatus: "SOMETHING_NEW" }],
    });
    expect(list.campaigns[0].status).toBe("UNKNOWN");
    expect(list.campaigns[0].rawStatus).toBe("SOMETHING_NEW");
  });
});

describe("shapeClaimResult", () => {
  it("uppercases the status and lifts the reward amount", () => {
    expect(shapeClaimResult({ status: "claimed", reward: { amount: 100 } })).toEqual({
      status: "CLAIMED",
      amount: 100,
    });
  });

  it("survives an empty or malformed body", () => {
    expect(shapeClaimResult(null)).toEqual({ status: "", amount: null });
    expect(shapeClaimResult({ status: "BLOCKED" }).amount).toBeNull();
  });
});
