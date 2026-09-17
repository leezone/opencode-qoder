import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROVIDER_ID,
  PROVIDER_ID_CN,
  type QoderEndpoints,
  regionOfProviderID,
  resolveEndpoints,
  sharedKey,
  stateFiles,
} from "../constants.js";
import { addPAT, getActivePatString, listPATs, patStoreFile, switchPAT } from "../pat-store.js";
import { clearAllTiers, getSelectedTier, listSelectedTiers, setTier } from "../tier-store.js";

// The two Qoder deployments share a process, so the thing that must be true is
// that nothing region-specific is shared: not a URL table, not a state file,
// not a globalThis cache slot. These tests pin that, because the failure mode
// is silent -- one region quietly answering with the other's account, catalog
// or tier selection.

const GLOBAL_PAT = "pt-aaaaaaaaaaaaaaaa";
const CN_PAT = "pt-bbbbbbbbbbbbbb";

const GLOBAL_STATE_KEYS = [
  "pat_store",
  "tier_store",
  "routing_policy",
  "key_file_state",
  "key_file_mtimes",
  "quota_exhausted",
  "refresh_trigger",
  "label_dirty",
  "pat_import_done",
];

function resetShared(): void {
  for (const region of ["global", "cn"] as const) {
    for (const name of GLOBAL_STATE_KEYS) {
      delete (globalThis as Record<string, unknown>)[sharedKey(name, region)];
    }
  }
  // The international region's historic keys predate sharedKey()'s prefix rule
  // for a couple of stores; clear the raw spellings too so no test inherits one.
  for (const legacy of ["__opencode_qoder_pat_store", "__opencode_qoder_tier_store"]) {
    delete (globalThis as Record<string, unknown>)[legacy];
  }
}

describe("region endpoints", () => {
  it("splits every host that differs between the deployments", () => {
    const g: QoderEndpoints = resolveEndpoints("global");
    const c: QoderEndpoints = resolveEndpoints("cn");
    expect(g.baseUrl).toBe("https://api3.qoder.sh/");
    expect(c.baseUrl).toBe("https://gateway.qoder.com.cn/");
    expect(g.openapi).toBe("https://openapi.qoder.sh");
    expect(c.openapi).toBe("https://openapi.qoder.com.cn");
    // The one asymmetry worth a dedicated assertion: the CN center is the SAME
    // host as its gateway, while the international center is a different host.
    expect(c.center).toBe(c.baseUrl.replace(/\/$/, ""));
    expect(g.center).not.toBe(g.baseUrl.replace(/\/$/, ""));
    expect(c.center).toBe("https://gateway.qoder.com.cn");
  });

  it("uses the CN refresh path, which is not the international one", () => {
    expect(resolveEndpoints("global").refresh).toBe(
      "https://center.qoder.sh/algo/api/v3/user/refresh_token",
    );
    expect(resolveEndpoints("cn").refresh).toBe(
      "https://gateway.qoder.com.cn/api/v1/deviceToken/refresh",
    );
  });

  it("derives every endpoint from one of the region's two hosts", () => {
    for (const region of ["global", "cn"] as const) {
      const e = resolveEndpoints(region);
      for (const url of [e.modelList, e.chat, e.quota, e.exchange, e.userinfo, e.campaigns]) {
        expect(url.startsWith(e.baseUrl) || url.startsWith(e.openapi)).toBe(true);
      }
    }
  });
});

describe("region state files", () => {
  it("gives every plugin-managed file its own name per region", () => {
    const g = stateFiles("global");
    const c = stateFiles("cn");
    for (const key of Object.keys(g) as Array<keyof typeof g>) {
      expect(c[key]).not.toBe(g[key]);
      // The international names are the historical ones, kept byte-identical so
      // an upgrade does not orphan an existing install's credentials.
      expect(g[key].startsWith("qoder-") || g[key].startsWith("opencode-qoder-")).toBe(true);
    }
    expect(g.pats).toBe("qoder-pats.json");
    expect(c.pats).toBe("qoder-cn-pats.json");
    expect(g.models).toBe("opencode-qoder-models.json");
    expect(c.models).toBe("opencode-qoder-cn-models.json");
  });

  it("scopes the globalThis keys, keeping the historic international spelling", () => {
    expect(sharedKey("pat_store", "global")).toBe("__opencode_qoder_pat_store");
    expect(sharedKey("pat_store", "cn")).toBe("__opencode_qoder_cn_pat_store");
  });
});

describe("region from provider id", () => {
  it("maps the CN provider id to the cn region and everything else to global", () => {
    expect(regionOfProviderID(PROVIDER_ID_CN)).toBe("cn");
    expect(regionOfProviderID(PROVIDER_ID)).toBe("global");
    expect(regionOfProviderID(undefined)).toBe("global");
    expect(regionOfProviderID("someone-elses-provider")).toBe("global");
  });
});

describe("stores are isolated per region", () => {
  let savedXdg: string | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-region-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    resetShared();
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(dir, { recursive: true, force: true });
    resetShared();
  });

  it("keeps PAT stores apart: a CN import never appears in the global store", () => {
    addPAT(GLOBAL_PAT, "Global One");
    addPAT(CN_PAT, "CN One", undefined, "cn");

    expect(listPATs("global").map((e) => e.label)).toEqual(["Global One"]);
    expect(listPATs("cn").map((e) => e.label)).toEqual(["CN One"]);
    expect(patStoreFile("global")).not.toBe(patStoreFile("cn"));
  });

  it("keeps the explicit selection per region", () => {
    const g = addPAT(GLOBAL_PAT, "Global One");
    const c = addPAT(CN_PAT, "CN One", undefined, "cn");
    switchPAT(g!.id, "global");
    switchPAT(c!.id, "cn");
    expect(getActivePatString("global")).toBe(GLOBAL_PAT);
    expect(getActivePatString("cn")).toBe(CN_PAT);
    // Clearing one region's selection must not touch the other's.
    expect(getActivePatString("global")).toBe(GLOBAL_PAT);
    expect(getActivePatString("cn")).toBe(CN_PAT);
  });

  it("keeps tier selections apart", () => {
    setTier("cmodel", 1_000_000, "global");
    setTier("cmodel", 400_000, "cn");
    expect(getSelectedTier("cmodel", "global")).toBe(1_000_000);
    expect(getSelectedTier("cmodel", "cn")).toBe(400_000);
    expect(listSelectedTiers("global")).toEqual({ cmodel: 1_000_000 });

    clearAllTiers("cn");
    expect(getSelectedTier("cmodel", "cn")).toBeUndefined();
    // The global selection survives a CN clear -- the bug this guards.
    expect(getSelectedTier("cmodel", "global")).toBe(1_000_000);
  });
});
