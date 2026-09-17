import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QoderCredentials } from "../auth.js";
import { authFailureError as __testAuthFailureError } from "../errors.js";
import { addPAT, invalidateStore } from "../pat-store.js";

// The point of the note: a dead credential blocks every model, including free
// lite (x0 skips credits, not authentication), and the in-chat switch tool needs
// a working conversation to fire from. So the note has to hand the user the
// shell path when the chat path is what just failed.

const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";

function credential(userID: string): QoderCredentials {
  return {
    access: "job-token",
    refresh: "refresh",
    expires: Number.MAX_SAFE_INTEGER,
    userID,
    email: "user@example.com",
    name: "user",
    machineID: "machine",
  };
}

function resetCaches(): void {
  invalidateStore();
  delete (globalThis as Record<string, unknown>).__opencode_qoder_pat_store;
}

let savedXdg: string | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-auth-note-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  resetCaches();
});

afterEach(() => {
  resetCaches();
  process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("authFailureError recovery note", () => {
  it("stays silent when the store holds only the active credential", () => {
    addPAT(ALPHA, "Primary"); // becomes active by being first
    const err = new Error("Qoder rejected the credential — Login expired (code 105)");
    const out = __testAuthFailureError(err, credential("real-uid"));
    expect(out).toBe(err);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).not.toMatch(/qoder_pat_switch|--use-pat/);
  });

  it("appends the backup ids and the shell escape hatch when a switch exists", () => {
    addPAT(ALPHA, "Primary");
    addPAT(BETA, "Backup");
    const err = new Error("Qoder rejected the credential");
    const out = __testAuthFailureError(err, credential("real-uid")) as Error;
    // The same object, message grown: an APICallError keeps its statusCode.
    expect(out).toBe(err);
    expect(out.message).toContain("Qoder rejected the credential");
    expect(out.message).toContain("qoder_pat_switch");
    // The skill script ships inside the package, so in any real checkout the
    // note can name it; the store-file fallback only applies when neither a
    // manual config-dir copy nor the bundled script exists.
    expect(out.message).toContain("inactive backup");
    expect(out.message).toContain("--pats");
    expect(out.message).toContain("no restart");
  });

  it("names the installed script when the skill is present", () => {
    const beta = addPAT(ALPHA, "Primary") && addPAT(BETA, "Backup")!;
    // Materialise the skill script where the note will look for it.
    const script = join(dir, "opencode", "skills", "qoder-quota", "scripts", "qoder-quota.mjs");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "#!/usr/bin/env node\n");
    const out = __testAuthFailureError(new Error("rejected"), credential("real-uid")) as Error;
    // A config-dir copy outranks the bundled script (it is what the host's
    // source dedup actually loads), so the note names that exact path.
    expect(out.message).toContain(`node ${script} --pats`);
    expect(out.message).toContain("--use-pat");
    expect(beta.id).toBeTruthy();
  });

  it("keeps an APICallError's identity through the mutation", () => {
    addPAT(ALPHA, "Primary");
    addPAT(BETA, "Backup");
    class Shaped extends Error {
      statusCode = 403;
      data = "raw envelope";
    }
    const err = new Shaped("forbidden");
    const out = __testAuthFailureError(err, credential("real-uid")) as Shaped;
    expect(out.statusCode).toBe(403);
    expect(out.data).toBe("raw envelope");
    expect(out.message).toContain("qoder_pat_switch");
  });

  it("warns when a configured credential outranks the store", () => {
    addPAT(ALPHA, "Primary");
    addPAT(BETA, "Backup");
    const err = new Error("rejected");
    const out = __testAuthFailureError(err, credential("real-uid"), {
      personalAccessToken: ALPHA,
    }) as Error;
    expect(out.message).toMatch(/outranks the PAT store/);
    expect(out.message).toMatch(/personalAccessToken/);
  });

  it("folds the note into the placeholder-uid diagnosis instead of replacing it", () => {
    addPAT(ALPHA, "Primary");
    addPAT(BETA, "Backup");
    const err = new Error("login expired");
    // QODER_DEFAULT_USER_ID is the placeholder the exchange signs when userinfo
    // resolved nothing -- that case already builds a fresh Error.
    const out = __testAuthFailureError(err, credential("qoder-user")) as Error;
    expect(out).not.toBe(err);
    expect(out.message).toContain("carried no");
    expect(out.message).toContain("qoder_pat_switch");
    expect(out.message).toContain("Original error: login expired");
  });
});
