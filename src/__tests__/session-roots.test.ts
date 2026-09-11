import { describe, expect, it } from "vitest";
import { forgetSession, recordSessionParent, resolveRootSession } from "../session-roots.js";

// The map is process-global and in-memory only (see session-roots.ts); tests
// use unique ids so they cannot collide with each other.
describe("session-roots", () => {
  it("resolves an unknown session to itself", () => {
    expect(resolveRootSession("ses_stranger")).toBe("ses_stranger");
  });

  it("walks a child chain to the root", () => {
    recordSessionParent("ses_t_b", "ses_t_a");
    recordSessionParent("ses_t_c", "ses_t_b");
    recordSessionParent("ses_t_d", "ses_t_c");
    expect(resolveRootSession("ses_t_d")).toBe("ses_t_a");
  });

  it("treats a parentless record as a root", () => {
    recordSessionParent("ses_t_root", undefined);
    expect(resolveRootSession("ses_t_root")).toBe("ses_t_root");
  });

  it("re-rooting a child drops its stale link", () => {
    recordSessionParent("ses_t_r1", "ses_t_parent");
    recordSessionParent("ses_t_r1", undefined);
    expect(resolveRootSession("ses_t_r1")).toBe("ses_t_r1");
  });

  it("survives a parent cycle via the depth guard", () => {
    // A -> B -> A: no id may hang the resolver or loop forever.
    recordSessionParent("ses_t_cyc_a", "ses_t_cyc_b");
    recordSessionParent("ses_t_cyc_b", "ses_t_cyc_a");
    const resolved = resolveRootSession("ses_t_cyc_a");
    expect(["ses_t_cyc_a", "ses_t_cyc_b"]).toContain(resolved);
  });

  it("survives a self-parent", () => {
    recordSessionParent("ses_t_self", "ses_t_self");
    expect(resolveRootSession("ses_t_self")).toBe("ses_t_self");
  });

  it("forgetSession drops the link and its children's links", () => {
    recordSessionParent("ses_f_child", "ses_f_parent");
    recordSessionParent("ses_f_grand", "ses_f_child");
    forgetSession("ses_f_parent");
    expect(resolveRootSession("ses_f_child")).toBe("ses_f_child");
    // The grandchild's link to the (still known) child survives -- one stale
    // hop is tolerated by design; resolution still terminates.
    expect(resolveRootSession("ses_f_grand")).toBe("ses_f_child");
  });

  it("ignores empty ids", () => {
    recordSessionParent("", "ses_x");
    recordSessionParent("  ", undefined);
    expect(resolveRootSession("")).toBe("");
    // Whitespace-only ids are trimmed to empty, never treated as a session.
    expect(resolveRootSession("   ")).toBe("");
  });
});
