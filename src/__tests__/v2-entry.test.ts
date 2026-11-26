import { describe, expect, it } from "vitest";
import { definePlugin, model as modelFactory } from "../index.js";

// The fake contexts below only need the transform callbacks to run. A loose
// editor shape keeps the fixtures readable without importing V2 host internals.
type Editor = Record<string, (...args: never[]) => unknown> & {
  update?: (id: string, mutate: (draft: Record<string, string>) => void) => void;
  default?: { set: (...args: never[]) => void };
  method?: { update: (...args: never[]) => void };
};

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

  it("exports model(modelID, settings) returning a v3 language model", () => {
    // OpenCode 2 loads a provider package by calling its `model` export. A
    // missing one fails before the aisdk language hook can run with
    // "Provider package ... does not export model(modelID, settings)".
    expect(typeof modelFactory).toBe("function");
    const language = modelFactory("efficient", {});
    expect(language.modelId).toBe("efficient");
    expect(language.specificationVersion).toBe("v3");
  });

  it("registers tools as direct tools that return clean results", async () => {
    // Two real-host findings on 2.4.2: tools without options.codemode=false are
    // hidden in Code Mode, and a result carrying output/metadata makes the host
    // drop it ("Tool result missing"). Both regressions would silently remove
    // qoder_quota / qoder_pat_switch from the model's reach.
    type Registered = { name: string; options?: Record<string, unknown> };
    const registered: Registered[] = [];
    const rec = () => Promise.resolve();
    const ctx = {
      options: {},
      provider: {
        transform: async (cb: (e: Editor) => void) => cb({ update: rec }),
        reload: rec,
      },
      model: {
        transform: async (cb: (e: Editor) => void) => cb({ update: rec, default: { set: rec } }),
        reload: rec,
      },
      integration: {
        transform: async (cb: (e: Editor) => void) => cb({ update: rec, method: { update: rec } }),
        connection: { active: async () => null, resolve: async () => null },
      },
      aisdk: { hook: rec },
      session: { hook: rec },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
      tool: {
        transform: async (cb: (e: { add: (t: Registered) => void }) => void) =>
          cb({
            add: (t) => {
              registered.push(t);
            },
          }),
      },
      skill: { transform: async (cb: (e: Editor) => void) => cb({ add: rec }), reload: rec },
    };
    await (definePlugin("global").setup as (c: unknown) => Promise<unknown>)(ctx);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.some((t) => t.name === "qoder_quota")).toBe(true);
    for (const tool of registered) {
      expect(tool.options?.codemode).toBe(false);
    }
  });

  it("registers the provider as an AISDK package", async () => {
    // V2 only bridges AI SDK models when the package carries the `aisdk:`
    // prefix. A plain file:// package is treated as a native provider and
    // fails schema validation ("Schema validation failed"), which is why the
    // package constant must keep this prefix.
    let registeredPackage = "";
    const rec = () => Promise.resolve();
    const ctx = {
      options: {},
      provider: {
        transform: async (cb: (e: Editor) => void) =>
          cb({
            update: (_id: string, mutate: (draft: Record<string, string>) => void) => {
              const draft: Record<string, string> = { package: "" };
              mutate(draft);
              registeredPackage = draft.package;
            },
          }),
        reload: rec,
      },
      model: {
        transform: async (cb: (e: Editor) => void) => cb({ update: rec, default: { set: rec } }),
        reload: rec,
      },
      integration: {
        transform: async (cb: (e: Editor) => void) => cb({ update: rec, method: { update: rec } }),
        connection: { active: async () => null, resolve: async () => null },
      },
      aisdk: { hook: rec },
      session: { hook: rec },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
      tool: { transform: async (cb: (e: Editor) => void) => cb({ add: rec }) },
      skill: { transform: async (cb: (e: Editor) => void) => cb({ add: rec }), reload: rec },
    };
    await (definePlugin("global").setup as (c: unknown) => Promise<unknown>)(ctx);
    expect(registeredPackage).toMatch(/^aisdk:/);
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
