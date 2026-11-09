import { FETCH_TIMEOUT_MS } from "./constants.js";
import { readEnv } from "./env.js";
import { fetchWithTimeout } from "./http.js";
import { opencodeCacheFile, readJsonFile, writeJsonFile } from "./json-store.js";
import { errorMessage, logPlugin } from "./log.js";

// The client version this plugin claims to be.
//
// Qoder gates model availability on it: the model list endpoint filters entries
// whose `minimal_version.cli` is above the `Cosy-Version` the caller sends. That
// is not cosmetic -- pinned at 1.1.42 this plugin never saw the `fast` tier
// (minimal_version.cli 1.1.70), so the picker was one model short of what the
// account was actually entitled to. The gate is the reason a literal here is a
// latent bug rather than a stale comment.
//
// Three sources, best first, resolved once per process:
//
//   env     -- QODER_CLIENT_VERSION, the escape hatch (staging, a pinned
//              rollback, reproducing an old client's view)
//   remote  -- npm dist-tags for @qoder-ai/qodercli, cached on disk
//   pinned  -- PINNED_VERSION, shipped with this release
//
// The remote lookup is what keeps the gate from silently re-closing: qodercli
// ships often, and a plugin that only bumps on release would fall behind again
// between upgrades. It is deliberately cheap (a 42-byte JSON document) and
// bounded by a short timeout, because a registry that is slow or blocked must
// never delay a model request.
//
// A version is never probed on the request path. resolveClientVersion() reads
// only the in-memory value, which starts as env-or-pinned and is replaced by a
// background refresh; the first request of a process therefore signs with a
// concrete, known-good value even if the network is down.

// Shipped fallback. Bumped when the plugin releases; NOT the source of truth
// once the remote probe succeeds.
const PINNED_VERSION = "1.1.86";

// The npm package whose `version` field qodercli reports as its Cosy-Version
// (its bundle sets `Cosy-Version = <its package version>`). Tracking the
// registry rather than a local install keeps this correct on machines that
// never installed qodercli -- opencode does not depend on it.
//
// The `/-/package/<name>/dist-tags` endpoint returns the tag map alone (~42
// bytes). The full packument is ~500KB and takes seconds; it must not be used
// here. npmmirror serves the identical shape and answered in well under 250ms
// where npmjs.com took 2-4s and failed intermittently from CN, so it is tried
// second -- the ordering is a latency/failure fallback, not a preference.
const REGISTRY_URLS = [
  "https://registry.npmjs.org/-/package/@qoder-ai/qodercli/dist-tags",
  "https://registry.npmmirror.com/-/package/@qoder-ai/qodercli/dist-tags",
] as const;

// A successful probe is good for a day; qodercli does not ship more often than
// that in practice, and one request per day is unnoticeable. A failure is
// retried sooner than the happy path but still throttled, so a machine behind a
// firewall does not hit the registry on every tick.
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 60 * 1000;

const DISK_CACHE_VERSION = 1;

type ProbeState = {
  version: string;
  // Where `version` came from. Rendered by the catalog diagnostics so "why
  // does my client version say 1.1.86" is answerable without a log file.
  source: "env" | "remote" | "pinned";
  fetchedAt: number;
  expiresAt: number;
  lastError: string;
  inflight?: Promise<void>;
};

// `null` until the first call: the module cannot read local state at import
// time -- env-isolation in tests and opencode's own load order both make an
// import-time read wrong.
let state: ProbeState | undefined;

function pinnedState(): ProbeState {
  return {
    version: PINNED_VERSION,
    source: "pinned",
    fetchedAt: 0,
    expiresAt: 0,
    lastError: "",
  };
}

function cachePath(): string {
  const override = readEnv("QODER_CLIENT_VERSION_CACHE");
  return override || opencodeCacheFile("opencode-qoder-client-version.json");
}

// "1.2.3" / "1.2.3-beta.1" only. The version rides a signed request header, so a
// malformed value from an env edit or a hijacked cache is rejected outright
// rather than forwarded -- the gateway's answer to garbage is a 4xx on every
// request, which is a much worse failure than staying on the pinned value.
function isPlausibleVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value.trim());
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isPlausibleVersion(trimmed) ? trimmed : undefined;
}

// Compares dotted numeric versions. Only ordering matters here: the plugin wants
// the higher of (pinned, remote) so a stale registry mirror can never walk the
// claimed version backwards, which would silently re-close a model gate.
function compareVersions(a: string, b: string): number {
  const core = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [aCore, bCore] = [core(a), core(b)];
  for (let i = 0; i < Math.max(aCore.length, bCore.length); i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A prerelease sorts below its release: 1.1.86-beta.1 < 1.1.86.
  const aPre = a.includes("-");
  const bPre = b.includes("-");
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}

function higher(a: string, b: string): string {
  return compareVersions(a, b) >= 0 ? a : b;
}

function seedFromDisk(): ProbeState {
  const base = pinnedState();
  const cached = readJsonFile("client-version", cachePath());
  if (!cached || typeof cached !== "object") return base;
  const record = cached as { version?: unknown; source?: unknown; version_tag?: unknown };
  // Bumped whenever this file's shape changes, so a record written by an older
  // release is ignored instead of being misread.
  if (record.version_tag !== DISK_CACHE_VERSION) return base;
  const version = normalize(record.version);
  if (!version) return base;
  // Never step below the pinned value, even if the cache says so: the pinned
  // version is known to work with this release's request signing.
  return { ...base, version: higher(version, PINNED_VERSION), source: "remote" };
}

function current(): ProbeState {
  if (state) return state;
  // Order: env beats disk beats pinned. The env layer is re-read on every
  // process start but memoized after that, matching how the rest of the plugin
  // treats operator overrides -- a mid-session change would re-sign in-flight
  // requests with a value opencode has already cached.
  const fromEnv = normalize(readEnv("QODER_CLIENT_VERSION"));
  if (fromEnv) {
    state = { ...pinnedState(), version: fromEnv, source: "env" };
  } else {
    state = seedFromDisk();
  }
  return state;
}

/**
 * The client version to sign requests with. Reads only in-memory state, so it
 * is safe to call on the request path.
 */
export function resolveClientVersion(): string {
  return current().version;
}

/** One diagnostics line: the value, where it came from, and any probe error. */
export function describeClientVersion(): string {
  const s = current();
  const provenance = s.source === "pinned" ? "shipped default" : s.source;
  return `${s.version} (${provenance}${s.lastError ? `, probe: ${s.lastError}` : ""})`;
}

/** The version compiled into this release, for tests and diagnostics. */
export const CLIENT_VERSION_FALLBACK = PINNED_VERSION;

export function clientVersionCachePath(): string {
  return cachePath();
}

// Tries each registry in order and returns the first usable answer. Every
// failure is collected: a report of "both mirrors failed" is what makes the
// probe line actionable, whereas the last error alone hides a different cause
// on the primary (a blocked npmjs.com behind a proxy, an npmmirror 404).
async function fetchLatestVersion(): Promise<string | undefined> {
  const failures: string[] = [];
  for (const url of REGISTRY_URLS) {
    try {
      const version = await fetchWithTimeout(
        url,
        // No Authorization, no COSY: this is a public registry, not a Qoder host.
        // The UA is the plugin's own so npm's logs do not attribute the probe to
        // qodercli itself.
        { headers: { Accept: "application/json", "User-Agent": "opencode-qoder" } },
        FETCH_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            throw new Error(`registry returned ${response.status}`);
          }
          const body = (await response.json()) as { latest?: unknown };
          return normalize(body?.latest);
        },
      );
      if (version) return version;
      failures.push(`${new URL(url).host}: no usable version`);
    } catch (err) {
      failures.push(`${new URL(url).host}: ${errorMessage(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return undefined;
}

/**
 * Re-reads the latest qodercli version from the registry, subject to the TTL.
 *
 * Never throws and never blocks a request: callers fire it and forget. Returns
 * the resolved version so a test (or a tool) can await a deterministic answer.
 */
export async function refreshClientVersion(force = false): Promise<string> {
  const s = current();
  // An explicit env override wins outright -- probing would only log a value
  // that is never used, which reads like a bug in the diagnostics.
  if (s.source === "env") return s.version;
  if (!force && Date.now() < s.expiresAt) return s.version;
  if (s.inflight) {
    await s.inflight;
    return current().version;
  }
  s.inflight = (async () => {
    try {
      const remote = await fetchLatestVersion();
      if (!remote) throw new Error("registry response carried no usable version");
      const next = higher(remote, PINNED_VERSION);
      const changed = next !== s.version;
      s.version = next;
      s.source = "remote";
      s.fetchedAt = Date.now();
      s.expiresAt = s.fetchedAt + OK_TTL_MS;
      s.lastError = "";
      writeJsonFile("client-version", cachePath(), {
        version_tag: DISK_CACHE_VERSION,
        version: next,
        source: "registry",
        fetchedAt: s.fetchedAt,
      });
      if (changed) {
        // The model list is filtered by this value, so a bump can unlock (or
        // re-lock) models. index.ts reloads the catalog when its signature
        // changes; the log line is what ties a new model to this event.
        logPlugin(`client-version: ${s.version} (registry; catalog may have changed)`);
      }
    } catch (error) {
      s.lastError = errorMessage(error);
      s.expiresAt = Date.now() + ERROR_TTL_MS;
      // Staying on the previous value is the whole point: a blocked registry is
      // not a reason to stop working, and the pinned/last-known value is known
      // to sign correctly.
      logPlugin(`client-version: probe failed, keeping ${s.version} (${s.lastError})`);
    } finally {
      s.inflight = undefined;
    }
  })();
  await s.inflight;
  return current().version;
}

/** Test seam: drop memoized state and the in-flight promise. */
export function resetClientVersionForTests(): void {
  state = undefined;
}
