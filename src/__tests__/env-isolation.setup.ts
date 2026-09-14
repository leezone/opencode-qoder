import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The plugin reads local state at import time -- the seed key file default,
// the PAT store, the disk catalog cache, opencode's auth.json -- and the
// precedence chain in auth.ts lets a stored, explicitly SELECTED PAT outrank
// even an apiKey a test passes in. On a machine where the plugin is installed
// and signed in, that real state leaked into every run: fake tokens lost to
// live credentials, fixture catalogs lost to the seeded disk cache.
//
// Point HOME and the XDG bases at a private empty tree, so every local-state
// layer starts in the "fresh install" state the tests were written against.
// Files that want state of their own (key-file, pat-store, xdg-paths, ...)
// override paths per test, exactly as before -- they only ever relied on the
// ABSENCE of real state at import time.
const SANDBOX = mkdtempSync(join(tmpdir(), "opencode-qoder-test-home-"));
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = join(SANDBOX, ".config");
process.env.XDG_DATA_HOME = join(SANDBOX, ".local", "share");
process.env.XDG_CACHE_HOME = join(SANDBOX, ".cache");

// Plugin-relevant variables from the runner's shell would re-open the same
// leak through another door (a live key file, a seed list, a quiet log).
// Tests that need any of them set it themselves; starting empty is the only
// hermetic default.
for (const key of [
  "OPENCODE_QODER_KEY_FILE",
  "OPENCODE_QODER_LOG_FILE",
  "OPENCODE_QODER_PAT",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODER_DISABLE_MODEL_DISCOVERY",
  "QODER_MODEL_CACHE_SECONDS",
  "QODER_MODEL_DISK_CACHE",
  "QODER_MODEL_LIST_URL",
  "QODER_REASONING_EFFORT",
  "QODER_STATIC_MODELS",
]) {
  delete process.env[key];
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
