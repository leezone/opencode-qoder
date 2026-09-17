import { describe, expect, it } from "vitest";
import { reportPatAdd, reportPatList, reportPatRemove, reportPatSwitch } from "../pat-tools.js";
import { getSelectedTier } from "../tier-store.js";
import { reportRoutingPolicy, reportTierList, reportTierSwitch } from "../tier-tools.js";

// Pins the contract of the tool surfaces moved out of index.ts (pat-tools.ts /
// tier-tools.ts): the report shape index.ts adapts into {output, metadata},
// the refusal paths that must NOT mutate the stores, and the injected refresh
// callback. env-isolation.setup.ts already points HOME/XDG at an empty tree,
// so these stores start fresh like the real file tests.

describe("pat-tools", () => {
  it("add/list/switch/remove round-trip emitting shapes only, never tokens", () => {
    const added = reportPatAdd("pt-test1234567890abcdef", "Test One");
    expect(added.output).toContain("Test One");
    expect(JSON.stringify(added.data)).not.toContain("pt-test1234567890abcdef");

    const listed = reportPatList();
    expect(listed.output).toContain("Test One");
    expect(JSON.stringify(listed.data)).not.toContain("pt-test1234567890abcdef");

    const id = (added.data as { entry: { id: string } }).entry.id;
    expect(reportPatSwitch(id).data).toEqual({ success: true, id });
    // Unknown ids fail softly; clearing without a selection reports cleared:false.
    expect(reportPatSwitch("pat_nope").data).toEqual({ success: false, id: "pat_nope" });
    expect(reportPatRemove("pat_nope").data).toEqual({ success: false, id: "pat_nope" });
    expect(reportPatRemove(id).data).toEqual({ success: true, id });
    expect(reportPatSwitch().data).toEqual({ success: true, cleared: false });
  });
});

describe("tier-tools", () => {
  it("refusal paths leave the tier store untouched", () => {
    const calls: Array<boolean | undefined> = [];
    const refresh = (labelChanged?: boolean) => {
      calls.push(labelChanged);
      return false;
    };
    expect(reportTierSwitch({ model: "ghost" }, undefined, "global", refresh).data).toEqual({
      success: false,
    });
    // 7 is valid against the bundled fallback (no advertised tiers -> any
    // value <= inputWindow passes), so probe refusal with an absurd ceiling.
    expect(
      reportTierSwitch({ model: "cmodel", tier: 999_999_999_999 }, undefined, "global", refresh)
        .data,
    ).toEqual({ success: false });
    // The no-session-id case degrades to picker-label mode; the bulk clear
    // fires refresh(false) -- with nothing selected, no label changed.
    const cleared = reportTierSwitch({ model: "*" }, undefined, "global", refresh);
    expect(cleared.data).toEqual({ success: true, model: "*", cleared: false });
    expect(calls).toEqual([false]);
    expect(getSelectedTier("cmodel")).toBeUndefined();
  });

  it("tier_list reports defaults when nothing is selected", () => {
    const report = reportTierList(undefined);
    expect(report.output).toContain("default tier (no switch yet)");
    expect(report.data).toMatchObject({ sessionTier: null });
    expect(Array.isArray((report.data as { tiers: unknown }).tiers)).toBe(true);
  });

  it("routing policy reads by default", () => {
    const read = reportRoutingPolicy({});
    expect(read.output).toContain("routing policy:");
    expect(read.data).toMatchObject({ success: true });
  });
});
