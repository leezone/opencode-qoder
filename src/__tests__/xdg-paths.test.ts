import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMachineId } from "../cosy.js";
import {
  legacyOpencodeDataFile,
  opencodeCacheFile,
  opencodeConfigFile,
  opencodeDataFile,
} from "../json-store.js";
import { catalogCachePath } from "../model-catalog.js";

// Path resolution for the plugin's state files and for opencode's own files.
//
// opencode resolves every XDG base the same way on every platform (no win32
// branch), so the plugin has to follow the variable, not the platform default:
// a user who moves their data dir moves auth.json with it, and a path built
// from ~/.local/share alone stops seeing it. The tests below set HOME to a
// temp directory, which os.homedir() honours live on POSIX, so the
// no-variable case asserts the real default instead of the runner's home.

const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

function seedEnv(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("opencode XDG paths", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of [...XDG, "HOME"]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function withHome(home: string | undefined): void {
    for (const key of XDG) delete process.env[key];
    saved.HOME = saved.HOME ?? process.env.HOME;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }

  it("falls back to the dotted directories when no variable is set", () => {
    const home = seedEnv("qoder-xdg-home-");
    dirs.push(home);
    withHome(home);
    // These three strings are what the plugin hardcoded before the bases were
    // centralised. Pinning them keeps the refactor behaviour-preserving for
    // every install that does not touch the variables -- the common case.
    expect(opencodeConfigFile("qoder-tiers.json")).toBe(
      join(home, ".config", "opencode", "qoder-tiers.json"),
    );
    expect(opencodeDataFile("auth.json")).toBe(
      join(home, ".local", "share", "opencode", "auth.json"),
    );
    expect(opencodeCacheFile("models.json")).toBe(join(home, ".cache", "opencode", "models.json"));
    expect(legacyOpencodeDataFile("auth.json")).toBe(
      join(home, ".local", "share", "opencode", "auth.json"),
    );
  });

  it("honours each variable the way opencode does", () => {
    const home = seedEnv("qoder-xdg-home-");
    const config = seedEnv("qoder-xdg-config-");
    const data = seedEnv("qoder-xdg-data-");
    const cache = seedEnv("qoder-xdg-cache-");
    dirs.push(home, config, data, cache);
    withHome(home);
    process.env.XDG_CONFIG_HOME = config;
    process.env.XDG_DATA_HOME = data;
    process.env.XDG_CACHE_HOME = cache;

    expect(opencodeConfigFile("qoder-routing.json")).toBe(
      join(config, "opencode", "qoder-routing.json"),
    );
    expect(opencodeDataFile("auth.json")).toBe(join(data, "opencode", "auth.json"));
    expect(opencodeCacheFile("models.json")).toBe(join(cache, "opencode", "models.json"));
    // The legacy helper is deliberately blind to the variable: that is the
    // whole point of keeping it around as a read fallback.
    expect(legacyOpencodeDataFile("qoder-machine-id")).toBe(
      join(home, ".local", "share", "opencode", "qoder-machine-id"),
    );
  });

  it("treats an empty variable as unset, like opencode's || does", () => {
    const home = seedEnv("qoder-xdg-home-");
    dirs.push(home);
    withHome(home);
    process.env.XDG_DATA_HOME = "";
    expect(opencodeDataFile("auth.json")).toBe(
      join(home, ".local", "share", "opencode", "auth.json"),
    );
  });

  it("keeps the model cache under the data dir's sibling, not the runner's home", () => {
    const home = seedEnv("qoder-xdg-home-");
    const cache = seedEnv("qoder-xdg-cache-");
    dirs.push(home, cache);
    withHome(home);
    process.env.XDG_CACHE_HOME = cache;
    expect(catalogCachePath()).toBe(join(cache, "opencode", "opencode-qoder-models.json"));
  });

  it("still lets QODER_MODEL_DISK_CACHE win over every base", () => {
    const home = seedEnv("qoder-xdg-home-");
    const cache = seedEnv("qoder-xdg-cache-");
    const cacheParent = seedEnv("qoder-xdg-override-");
    const override = join(cacheParent, "put-here.json");
    dirs.push(home, cache, cacheParent);
    withHome(home);
    process.env.XDG_CACHE_HOME = cache;
    process.env.QODER_MODEL_DISK_CACHE = override;
    try {
      expect(catalogCachePath()).toBe(override);
    } finally {
      delete process.env.QODER_MODEL_DISK_CACHE;
    }
  });
});

describe("getMachineId across a data-dir move", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ["XDG_DATA_HOME", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function isolated(): { home: string; data: string; legacy: string; current: string } {
    const home = mkdtempSync(join(tmpdir(), "qoder-mid-home-"));
    const data = mkdtempSync(join(tmpdir(), "qoder-mid-data-"));
    dirs.push(home, data);
    for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"])
      delete process.env[key];
    saved.HOME = saved.HOME ?? process.env.HOME;
    process.env.HOME = home;
    return {
      home,
      data,
      legacy: join(home, ".local", "share", "opencode", "qoder-machine-id"),
      current: join(data, "opencode", "qoder-machine-id"),
    };
  }

  it("writes a fresh id into the data dir the variable points at", () => {
    const env = isolated();
    process.env.XDG_DATA_HOME = env.data;
    const id = getMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(env.current, "utf8")).toBe(id);
    // Nothing is written to the pre-variable location any more.
    expect(existsSync(env.legacy)).toBe(false);
  });

  it("keeps the id written before the variable existed instead of churning it", () => {
    const env = isolated();
    mkdirSync(join(env.legacy, ".."), { recursive: true });
    writeFileSync(env.legacy, "old-machine-id", "utf8");
    process.env.XDG_DATA_HOME = env.data;

    expect(getMachineId()).toBe("old-machine-id");
    // The id is a signing input: honouring the old file must not also
    // duplicate it, or the next read would have two answers to choose from.
    expect(existsSync(env.current)).toBe(false);
  });

  it("prefers qodercli's own id when both exist", () => {
    const env = isolated();
    const cli = join(env.home, ".qoder", ".auth", "machine_id");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "cli-machine-id", "utf8");
    mkdirSync(join(env.current, ".."), { recursive: true });
    writeFileSync(env.current, "plugin-machine-id", "utf8");
    expect(getMachineId()).toBe("cli-machine-id");
  });

  it("is unchanged for an install that never set the variable", () => {
    const env = isolated();
    const expected = join(env.home, ".local", "share", "opencode", "qoder-machine-id");
    expect(getMachineId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(expected, "utf8")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
