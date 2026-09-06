import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Only the pure parser helpers are imported statically: they read no environment
// and touch no disk. Anything derived from QODER_MODELS must be re-imported
// under a pinned environment (see reload()), because static-models.ts resolves
// the table once at import time.
import { isSaneStaticModel, parseStaticModels } from "../static-models.js";

const valid = {
  id: "auto",
  name: "Auto",
  reasoning: false,
  supportsEffort: false,
  input: ["text", "image"],
  contextWindow: 200000,
  inputWindow: 200000,
  maxTokens: 32768,
};

describe("static models parsing", () => {
  it("accepts a bare array", () => {
    expect(parseStaticModels(JSON.stringify([valid]), "test")).toHaveLength(1);
  });

  it("accepts a { models: [...] } wrapper", () => {
    expect(parseStaticModels(JSON.stringify({ models: [valid] }), "test")).toHaveLength(1);
  });

  it("drops an invalid entry but keeps the sane ones", () => {
    // One hand-edit typo must not blank the whole picker.
    const broken = { ...valid, contextWindow: -1 };
    const parsed = parseStaticModels(JSON.stringify([broken, valid]), "test");
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].id).toBe("auto");
  });

  it("rejects inputWindow larger than contextWindow", () => {
    // opencode derives the compaction threshold from inputWindow, so an entry
    // whose input budget exceeds its context is worse than no entry.
    expect(isSaneStaticModel({ ...valid, inputWindow: 1000000 })).toBe(false);
    expect(isSaneStaticModel(valid)).toBe(true);
    expect(parseStaticModels(JSON.stringify([{ ...valid, inputWindow: 1000000 }]), "test")).toBe(
      undefined,
    );
  });

  it("returns undefined for garbage and for an empty table", () => {
    expect(parseStaticModels("not json", "test")).toBeUndefined();
    expect(parseStaticModels(JSON.stringify([{ id: "x" }]), "test")).toBeUndefined();
    expect(parseStaticModels(JSON.stringify({ nope: [] }), "test")).toBeUndefined();
    expect(parseStaticModels(JSON.stringify([]), "test")).toBeUndefined();
  });
});

// static-models.ts is resolved once per import, so exercising either the
// shipped table or the search order needs a fresh module under a controlled
// environment.
async function reload() {
  vi.resetModules();
  return (await import("../static-models.js")) as typeof import("../static-models.js");
}

describe("static models", () => {
  let dir: string;
  const saved = {
    staticPath: process.env.QODER_STATIC_MODELS,
    xdg: process.env.XDG_CONFIG_HOME,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-static-"));
    delete process.env.QODER_STATIC_MODELS;
    // Pin the user-override candidate to a dir that does not exist, so a real
    // ~/.config/opencode/qoder-models.json on the host cannot change an answer.
    process.env.XDG_CONFIG_HOME = join(dir, "absent-config");
  });

  afterEach(() => {
    if (saved.staticPath === undefined) delete process.env.QODER_STATIC_MODELS;
    else process.env.QODER_STATIC_MODELS = saved.staticPath;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("ships 16 entries and excludes the retired preview ids", async () => {
    // The prefab mirrors the live list. qmodel_preview and gm51model are no
    // longer advertised upstream, so they must not reappear through the fallback
    // path either -- the picker should never offer an unpriced model.
    const mod = await reload();
    const ids = mod.QODER_MODELS.map((model) => model.id);
    expect(mod.QODER_MODELS).toHaveLength(16);
    expect(ids).not.toContain("qmodel_preview");
    expect(ids).not.toContain("gm51model");
    expect(ids).toContain("auto");
  });

  it("ships entries that each pass the same validator a hand-edit must pass", async () => {
    const mod = await reload();
    for (const model of mod.QODER_MODELS) {
      expect(isSaneStaticModel(model)).toBe(true);
    }
  });

  it("prefers QODER_STATIC_MODELS when it holds a good table", async () => {
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify([{ ...valid, id: "only-one", name: "Only One" }]));
    process.env.QODER_STATIC_MODELS = file;
    const mod = await reload();
    expect(mod.QODER_MODELS).toHaveLength(1);
    expect(mod.QODER_MODELS[0].id).toBe("only-one");
    expect(mod.STATIC_MODELS_ORIGIN).toContain("env");
  });

  it("falls through to the shipped table when the override is broken", async () => {
    // A bad hand-edit must degrade to the prefab, not to nothing.
    const file = join(dir, "broken.json");
    writeFileSync(file, "{ this is not json");
    process.env.QODER_STATIC_MODELS = file;
    const mod = await reload();
    expect(mod.QODER_MODELS).toHaveLength(16);
    expect(mod.STATIC_MODELS_ORIGIN).toBe("shipped");
  });

  it("reads a user override from the config dir when no env is set", async () => {
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(
      join(dir, "opencode", "qoder-models.json"),
      JSON.stringify({ models: [{ ...valid, id: "mine", name: "Mine" }] }),
    );
    process.env.XDG_CONFIG_HOME = dir;
    const mod = await reload();
    expect(mod.QODER_MODELS).toHaveLength(1);
    expect(mod.QODER_MODELS[0].id).toBe("mine");
    expect(mod.STATIC_MODELS_ORIGIN).toBe("user override");
  });

  it("sits between the env override and the shipped file in precedence", async () => {
    // Both override sources present: the env one wins, proving the order is
    // env -> user -> shipped rather than whichever was written first.
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(
      join(dir, "opencode", "qoder-models.json"),
      JSON.stringify([{ ...valid, id: "from-user", name: "From User" }]),
    );
    const envFile = join(dir, "env.json");
    writeFileSync(envFile, JSON.stringify([{ ...valid, id: "from-env", name: "From Env" }]));
    process.env.XDG_CONFIG_HOME = dir;
    process.env.QODER_STATIC_MODELS = envFile;
    const mod = await reload();
    expect(mod.QODER_MODELS[0].id).toBe("from-env");
  });
});
