import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPAT,
  getSelectedPatString,
  invalidateStore,
  listPATs,
  switchPAT,
} from "../pat-store.js";
import { shapeQuota } from "../quota.js";
import {
  credentialLayers,
  probePat,
  runQuotaCli,
  runResolveCli,
  runUsePatCli,
  standaloneCredential,
} from "../quota-cli.js";

// The standalone CLI (quota-cli.ts) is the credential chain, the PAT store and
// the quota bucket table RE-EXPORTED for the skill script, so the script can no
// longer answer a different question than the chat tools. These are the two
// drift bugs that re-export exists to kill, tested as regressions:
//
//   * H2 -- a payload carrying an org package AND a shared package must count
//     both. The plugin once folded `shared_quota` into the org bucket with
//     first-match-wins, so the shared number silently vanished from
//     "Total left" whenever both fields were present;
//   * M1 -- the layer walk must match auth.ts: the store's selection outranks
//     the disk auth.json and the config apiKey, and the environment lands
//     LAST. The script used to rank env first, which meant cron and chat
//     could sign with different accounts.

const ALPHA = "pt-aaaaaaaaaaaaaaaa";
const BETA = "pt-bbbbbbbbbbbbbbbb";
const GAMMA = "pt-cccccccccccccccc";
const DELTA = "pt-dddddddddddddddd";

function resetCaches(): void {
  invalidateStore();
  for (const key of [
    "__opencode_qoder_pat_store",
    "__opencode_qoder_key_file_path",
    "__opencode_qoder_key_file_state",
    "__opencode_qoder_key_file_mtimes",
    "__opencode_qoder_exchange_cache",
    "__opencode_qoder_api_key",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

let dir: string;
const saved = new Map<string, string | undefined>();
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_QODER_KEY_FILE",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-cli-"));
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_DATA_HOME = join(dir, "data");
  // A path that cannot exist: absent, and NOT the developer's real ~/.qoderkey_env.
  process.env.OPENCODE_QODER_KEY_FILE = join(dir, "keyfile");
  mkdirSync(join(dir, "config", "opencode"), { recursive: true });
  mkdirSync(join(dir, "data", "opencode"), { recursive: true });
  resetCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  rmSync(dir, { recursive: true, force: true });
  resetCaches();
});

function writeAuthJson(token: string): void {
  writeFileSync(
    join(dir, "data", "opencode", "auth.json"),
    JSON.stringify({ qoder: { key: token } }),
  );
}

function writeConfigApi(key: string): void {
  writeFileSync(
    join(dir, "config", "opencode", "opencode.json"),
    JSON.stringify({ provider: { qoder: { options: { apiKey: key } } } }),
  );
}

describe("shapeQuota bucket table (H2)", () => {
  it("counts org package and shared package as separate buckets", () => {
    const usage = shapeQuota({
      user_quota: { remaining: 100, used: 50, total: 150 },
      add_on_quota: { remaining: 20, used: 0, total: 20 },
      org_resource_package: { remaining: 30, used: 10, cap: 40 },
      shared_quota: { remaining: 7, used: 3, cap: 10 },
    });
    expect(usage.buckets.filter((b) => b.present).map((b) => b.key)).toEqual([
      "userQuota",
      "addOnQuota",
      "orgPackage",
      "sharedPackage",
    ]);
    // The merge this guards against would have reported 150, silently dropping
    // the shared number out of "Total left".
    expect(usage.remainingTotal).toBe(157);
  });

  it("still honours the camelCase spellings of both fields", () => {
    const usage = shapeQuota({
      orgResourcePackage: { remaining: 30, used: 10, cap: 40 },
      sharedQuota: { remaining: 7, used: 3, cap: -1 },
    });
    const org = usage.buckets.find((b) => b.key === "orgPackage");
    const shared = usage.buckets.find((b) => b.key === "sharedPackage");
    expect(org?.present).toBe(true);
    expect(shared?.present).toBe(true);
    expect(shared?.unlimited).toBe(true);
    expect(shared?.ceiling).toBe(null);
    expect(usage.remainingTotal).toBe(37);
  });
});

describe("credentialLayers walk (M1)", () => {
  it("puts the explicit CLI acts above the whole table", () => {
    addPAT(ALPHA, "store");
    const rows = credentialLayers({ personalAccessToken: BETA });
    expect(rows[0]).toEqual({ layer: "--pat (CLI)", token: BETA });
    expect(standaloneCredential({ personalAccessToken: BETA })?.layer).toBe("--pat (CLI)");
  });

  it("ranks selection above auth.json, config apiKey and the active entry", () => {
    addPAT(ALPHA, "first"); // auto-activated, NOT selected
    switchPAT(listPATs()[0].id); // now selected as well
    writeAuthJson(GAMMA);
    writeConfigApi(DELTA);
    const rows = credentialLayers();
    const chosen = standaloneCredential();
    expect(chosen?.layer).toBe("pat-store selection");
    expect(rows.findIndex((r) => r.layer === "pat-store selection")).toBeLessThan(
      rows.findIndex((r) => r.token === GAMMA),
    );
    expect(rows.findIndex((r) => r.token === GAMMA)).toBeLessThan(
      rows.findIndex((r) => r.token === DELTA),
    );
  });

  it("outranks a bare env credential over nothing, but loses to every layer above it", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = ALPHA;
    expect(standaloneCredential()?.layer).toBe("env (QODER_*)");
    writeAuthJson(BETA);
    expect(standaloneCredential()?.layer).toBe("opencode auth.json");
    rmSync(join(dir, "data", "opencode", "auth.json"));
    addPAT(GAMMA, "store"); // active without selection still beats env
    expect(standaloneCredential()?.layer).toBe("pat-store active");
  });

  it("skips a commented-out apiKey and a seed LIST in config", () => {
    writeFileSync(
      join(dir, "config", "opencode", "opencode.json"),
      [
        "{",
        '  // "provider": { "qoder": { "options": { "apiKey": "pt-1111111111111111" } } }',
        '  "provider": { "qoder": { "options": { "apiKey": "pt-2222222222222222,pt-3333333333333333" } } } }',
      ].join("\n"),
    );
    expect(standaloneCredential()).toBe(null);
  });
});

describe("runResolveCli (offline diagnosis)", () => {
  it("never throws and exits 1 with no credential at all", () => {
    const report = runResolveCli({});
    expect(report.exitCode).toBe(1);
    expect(report.stderr).toContain("no layer supplied a credential");
    expect(report.output).toContain("pat-store selection");
  });

  it("names the winning layer and never leaks a token into the JSON", () => {
    addPAT(ALPHA, "Work");
    const report = runResolveCli({ json: true });
    expect(report.exitCode).toBe(0);
    const data = JSON.parse(report.output);
    expect(data.resolvedVia).toBe("pat-store active");
    expect(report.output).not.toContain(ALPHA);
    expect(report.output).toContain("fingerprint");
  });

  it("renders the selection row with its id and label, not a hash alone", () => {
    addPAT(ALPHA, "Home office");
    switchPAT(listPATs()[0].id);
    const report = runResolveCli({});
    expect(report.output).toMatch(/pat-store selection\s+\S{12}\s+\S+ \(Home office\)/);
    expect(report.output).toContain("stored account:");
  });
});

describe("probePat + runUsePatCli (recovery hatch)", () => {
  // The gate that makes --use-pat safe: a probe verdict decides whether the
  // store is written, and every no-write path must leave the store byte-exact.

  function stubGateway(opts: {
    exchange?: { status: number; body: unknown };
    quota?: { status: number; body: unknown };
    throwNetwork?: boolean;
  }): { exchanges: string[] } {
    const exchanges: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
      const href = String(input);
      if (opts.throwNetwork) throw new Error("fetch failed: network failure");
      if (href.includes("/jobToken/exchange")) {
        exchanges.push(String(JSON.parse(String(init?.body)).personal_token));
        const stub = opts.exchange ?? { status: 200, body: { token: "jt", expires_in: 86_400 } };
        return Response.json(stub.body, { status: stub.status });
      }
      if (href.includes("/userinfo")) {
        return Response.json({ id: "user-1", email: "u@example.com", name: "U" });
      }
      if (href.includes("/quota/usage")) {
        const stub = opts.quota ?? { status: 200, body: { user_quota: { remaining: 500 } } };
        return Response.json(stub.body, { status: stub.status });
      }
      return Response.json({}, { status: 404 });
    });
    return { exchanges };
  }

  it("classifies a rejected exchange as DEAD and a network failure as UNREACHABLE", async () => {
    stubGateway({ exchange: { status: 400, body: { message: "bad token" } } });
    expect((await probePat(ALPHA)).status).toBe("DEAD");
    vi.unstubAllGlobals();
    stubGateway({ throwNetwork: true });
    expect((await probePat(BETA)).status).toBe("UNREACHABLE");
  });

  it("refuses --use-pat on a dead credential and writes nothing", async () => {
    const first = addPAT(ALPHA, "keep");
    const dead = addPAT(BETA, "dead one");
    switchPAT(first!.id); // pin the current choice first
    stubGateway({ exchange: { status: 401, body: { message: "nope" } } });
    const report = await runUsePatCli(dead!.id);
    expect(report.exitCode).toBe(1);
    expect(report.stderr).toContain("Refusing to activate");
    expect(getSelectedPatString()).toBe(ALPHA); // untouched
  });

  it("switches (active AND selected) when the probe says alive", async () => {
    addPAT(ALPHA, "keep");
    const fresh = addPAT(BETA, "backup");
    stubGateway({});
    const report = await runUsePatCli(fresh!.id);
    expect(report.exitCode).toBe(0);
    expect(getSelectedPatString()).toBe(BETA);
    expect(listPATs().find((e) => e.active)?.pat).toBe(BETA);
    expect(report.output).toContain("500 credits");
  });

  it("--force writes despite an exhausted probe", async () => {
    const target = addPAT(ALPHA, "spent");
    // A payload without user_id + user_type is treated as malformed and is
    // never "exhausted" (isQuotaExhausted's guard), so the identity fields are
    // required here, not decoration.
    stubGateway({
      quota: {
        status: 200,
        body: {
          user_id: "user-1",
          user_type: "personal_professional",
          user_quota: { remaining: 0 },
          is_quota_exceeded: true,
        },
      },
    });
    const refusal = await runUsePatCli(target!.id);
    expect(refusal.stderr).toContain("EXHAUSTED");
    expect(refusal.stderr).toContain("--force");
    expect(getSelectedPatString()).toBeUndefined();
    const forced = await runUsePatCli(target!.id, { force: true });
    expect(forced.exitCode).toBe(0);
    expect(getSelectedPatString()).toBe(ALPHA);
  });

  it("refuses unknown and ambiguous targets before any network call", async () => {
    addPAT(ALPHA, "same");
    addPAT(BETA, "same");
    vi.stubGlobal("fetch", async () => {
      throw new Error("must not reach the network for refusal paths");
    });
    expect((await runUsePatCli("pat_missing")).exitCode).toBe(1);
    const ambiguous = await runUsePatCli("same");
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("several labels");
    expect((await runUsePatCli("anything")).exitCode).toBe(1); // empty-store guidance too
  });

  // The bug this pins: region was computed and used for the layer TABLE, but
  // dropped when the options bag for the actual calls was built. So
  // `--region=cn` walked the CN store and then signed against the
  // international host -- which answered normally, making CN look verified.
  // Recording hosts, not just statuses, is the only way to catch it: a wrong
  // host is not an error, it is a plausible success.
  describe("region is carried into the request, not just the layer table", () => {
    function recordingGateway(): { hosts: string[] } {
      const hosts: string[] = [];
      vi.stubGlobal("fetch", async (input: unknown) => {
        const url = new URL(String(input));
        hosts.push(url.host);
        if (url.pathname.includes("/jobToken/exchange")) {
          return Response.json({ token: "jt", expires_in: 86_400 });
        }
        if (url.pathname.includes("/userinfo")) {
          return Response.json({ id: "user-1", email: "u@example.com", name: "U" });
        }
        return Response.json({ user_quota: { remaining: 500 } });
      });
      return { hosts };
    }

    it("sends a CN run to the CN hosts", async () => {
      const { hosts } = recordingGateway();
      // The entry must live in the CN store, or the CLI refuses before dialing
      // and the host assertion would pass vacuously.
      const entry = addPAT(ALPHA, "cn", undefined, "cn")!;
      await runUsePatCli(entry.id, { region: "cn", force: true });
      expect(hosts.length).toBeGreaterThan(0);
      for (const host of hosts) expect(host.endsWith("qoder.com.cn")).toBe(true);
      expect(hosts).toContain("openapi.qoder.com.cn");
    });

    it("sends a global run to the international hosts", async () => {
      const { hosts } = recordingGateway();
      await runUsePatCli(addPAT(ALPHA, "global")!.id, { region: "global", force: true });
      for (const host of hosts) expect(host.endsWith("qoder.sh")).toBe(true);
      expect(hosts).toContain("openapi.qoder.sh");
    });

    it("probePat follows the region it is given", async () => {
      const { hosts } = recordingGateway();
      await probePat(ALPHA, "cn");
      for (const host of hosts) expect(host.endsWith("qoder.com.cn")).toBe(true);
    });

    // runQuotaCli is the default path the skill script takes, and it had no
    // test at all -- which is how the dropped region survived review.
    it("runQuotaCli sends a CN run to the CN hosts", async () => {
      const { hosts } = recordingGateway();
      addPAT(ALPHA, "cn", undefined, "cn");
      const report = await runQuotaCli({ region: "cn" });
      expect(hosts.length).toBeGreaterThan(0);
      for (const host of hosts) expect(host.endsWith("qoder.com.cn")).toBe(true);
      expect(hosts).toContain("openapi.qoder.com.cn");
      expect(report.exitCode).toBe(0);
    });

    it("runQuotaCli sends a global run to the international hosts", async () => {
      const { hosts } = recordingGateway();
      addPAT(ALPHA, "global");
      await runQuotaCli({ region: "global" });
      for (const host of hosts) expect(host.endsWith("qoder.sh")).toBe(true);
      expect(hosts).toContain("openapi.qoder.sh");
    });
  });
});
