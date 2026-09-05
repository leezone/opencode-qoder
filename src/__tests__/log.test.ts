import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logPlugin } from "../log.js";

const ENV = "OPENCODE_QODER_LOG_FILE";

describe("logPlugin", () => {
  const dirs: string[] = [];
  const saved = process.env[ENV];

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-log-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("writes nothing when the variable is unset -- the production default", () => {
    const dir = tmp();
    const file = join(dir, "plugin.log");
    delete process.env[ENV];
    logPlugin("quota: exhausted=false");
    // Not merely empty: the file must not come into existence at all.
    expect(existsSync(file)).toBe(false);
  });

  it("writes nothing when the variable is blank", () => {
    const dir = tmp();
    const file = join(dir, "plugin.log");
    process.env[ENV] = "   ";
    logPlugin("quota: exhausted=false");
    expect(existsSync(file)).toBe(false);
  });

  it("appends a timestamped, prefixed line when the variable is set", () => {
    const file = join(tmp(), "plugin.log");
    process.env[ENV] = file;
    logPlugin("quota: exhausted=false userQuota=0/3000");
    logPlugin("catalog: changed");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[opencode-qoder:[a-z0-9]+] /);
    }
    expect(lines[0]).toContain("quota: exhausted=false userQuota=0/3000");
    expect(lines[1]).toContain("catalog: changed");
  });

  it("reads the variable per call, so it can be switched on without a restart", () => {
    const file = join(tmp(), "plugin.log");
    delete process.env[ENV];
    logPlugin("dropped");
    process.env[ENV] = file;
    logPlugin("kept");
    expect(readFileSync(file, "utf8")).not.toContain("dropped");
    expect(readFileSync(file, "utf8")).toContain("kept");
  });

  it("swallows an unwritable path instead of throwing", () => {
    // A directory in place of a file: appendFileSync fails with EISDIR. Breaking
    // model discovery over a bad log path would be far worse than losing the log.
    const dir = tmp();
    process.env[ENV] = dir;
    expect(() => logPlugin("quota: exhausted=true")).not.toThrow();
  });
});
