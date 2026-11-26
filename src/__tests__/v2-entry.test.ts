import { describe, expect, it } from "vitest";
import { definePlugin } from "../index.js";

// One package ships two plugin contracts: OpenCode 1 calls `server()` and its
// own `setup()` with a catalog-style context; OpenCode 2 calls only `setup()`
// with a provider/model-style context. A wrong dispatch would register into a
// domain the host never reads -- the provider silently breaks with no error,
// so this test is the tripwire for the shape check.
//
// The fake contexts cover only the methods setup() touches. No network is on
// the setup path (discovery timers are unref'd and fire after the test).

function recorder(calls: string[]) {
  return (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return Promise.resolve();
    };
}

describe("dual V1/V2 plugin entry", () => {
  it("exports a V2-compatible id/setup shape alongside the V1 server()", async () => {
    const plugin = definePlugin("global");
    expect(plugin.id).toBe("opencode-qoder");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("routes a provider/model context through the V2 setup", async () => {
    const calls: string[] = [];
    const rec = recorder(calls);
    const ctx = {
      options: {},
      provider: {
        transform: async (cb: (e: unknown) => void) => cb({ update: rec("provider.update") }),
        reload: rec("provider.reload"),
      },
      model: {
        transform: async (cb: (e: unknown) => void) =>
          cb({ update: rec("model.update"), default: { set: rec("model.default.set") } }),
        reload: rec("model.reload"),
      },
      integration: {
        transform: async (cb: (e: unknown) => void) =>
          cb({ update: rec("integration.update"), method: { update: rec("method.update") } }),
        connection: { active: async () => null, resolve: async () => null },
      },
      aisdk: { hook: rec("aisdk.hook") },
      session: { hook: rec("session.hook") },
      event: {
        subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      },
      tool: { transform: async (cb: (e: unknown) => void) => cb({ add: rec("tool.add") }) },
      skill: {
        transform: async (cb: (e: unknown) => void) => cb({ add: rec("skill.add") }),
        reload: rec("skill.reload"),
      },
    };

    const cleanup = await (definePlugin("global").setup as (c: unknown) => Promise<unknown>)(ctx);
    expect(typeof cleanup).toBe("function");
    expect(calls).toContain("provider.update");
    expect(calls).toContain("model.update");
    expect(calls).toContain("tool.add");
    expect(calls).toContain("aisdk.hook");
    expect(calls).toContain("session.hook");
    // A V2 context has no catalog -- the V1 path must not have been used.
    expect(calls).not.toContain("catalog.provider.update");
    (cleanup as () => void)();
  });

  it("routes a catalog context through the 1.x setup", async () => {
    const calls: string[] = [];
    const rec = recorder(calls);
    const ctx = {
      options: {},
      catalog: {
        transform: async (cb: (e: unknown) => void) =>
          cb({
            provider: { update: rec("catalog.provider.update") },
            model: {
              update: rec("catalog.model.update"),
              default: { set: rec("catalog.model.default.set") },
            },
          }),
        reload: rec("catalog.reload"),
      },
      integration: {
        transform: async (cb: (e: unknown) => void) =>
          cb({ update: rec("integration.update"), method: { update: rec("method.update") } }),
        connection: { active: async () => null },
      },
      aisdk: { language: rec("aisdk.language") },
      skill: {
        transform: async (cb: (e: unknown) => void) => cb({ source: rec("skill.source") }),
        reload: rec("skill.reload"),
      },
    };

    await (definePlugin("global").setup as (c: unknown) => Promise<unknown>)(ctx);
    expect(calls).toContain("catalog.provider.update");
    expect(calls).toContain("catalog.model.update");
    expect(calls).toContain("aisdk.language");
    // The V2 path must not have been used.
    expect(calls).not.toContain("provider.update");
    expect(calls).not.toContain("tool.add");
  });
});
