// Cross-realm shared state, and the credential channel built on it.
//
// opencode loads this plugin twice in one process: once for the legacy config
// hooks, once for the v2 catalog hooks. Established by logging a per-instance
// id alongside the pid -- same pid, different instance ids, and neither can
// read the other's module state. A module-level `configuredApiKey`, store
// cache or session map therefore cannot work: the instance that captures the
// value is not always the instance that consumes it.
//
// They do share a realm, so globalThis is the one channel available. The
// modules that cross the boundary read and write through these helpers, so a
// key rename lands everywhere at once.
//
// Values stay in process memory: never written to disk, never logged --
// logPlugin only ever receives describeTokenShape() output. The same
// credentials already live in this realm inside opencode's own config/auth
// store, so this does not widen exposure; the fixed keys are a collision
// risk, not a leak.

import { nonEmptyString } from "./coerce.js";

export function readShared<T = unknown>(key: string): T | undefined {
  return (globalThis as Record<string, unknown>)[key] as T | undefined;
}

export function writeShared(key: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

// Credential channel between the two module instances. Carries the token from
// the legacy config hook (which sees the user's provider options already
// resolved from `{file:...}`) to the v2 instance's discovery path (whose
// ctx.options is empty and whose ctx exposes no config or provider key), and
// back to the capability layer on the legacy side.
export const CREDENTIAL_KEY = "__opencode_qoder_api_key";

export function readSharedApiKey(): string | undefined {
  return nonEmptyString(readShared(CREDENTIAL_KEY));
}

// First writer wins: a later hook invocation must not replace a working token
// with an empty one, and an unresolved `{file:...}` reference must not
// overwrite a real token either. Returns whether this call published it.
export function publishSharedApiKey(apiKey: string): boolean {
  if (readSharedApiKey() !== undefined) return false;
  writeShared(CREDENTIAL_KEY, apiKey);
  return true;
}
