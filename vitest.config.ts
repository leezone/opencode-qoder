import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file runs against a private empty HOME/XDG tree -- the
    // plugin's local-state layers (key file, PAT store, disk catalog cache,
    // auth.json) must start "not installed", or real credentials on a
    // developer's machine outrank the fixtures. See the setup for the why.
    setupFiles: ["src/__tests__/env-isolation.setup.ts"],
  },
});
