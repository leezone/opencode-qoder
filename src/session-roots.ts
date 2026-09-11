import { logPlugin } from "./log.js";

// Session parent chain.
//
// opencode gives every subagent spawn (task tool) and compaction its own
// session; requests from those children carry the CHILD session id in their
// X-Session-Id header. Session-level state like the conversation's context
// tier is keyed by the ROOT session, so the request layer needs a child ->
// root resolver, and the only place that learns the link is the event stream
// (session.created properties carry the Session, including parentID).
//
// The map lives on globalThis: the event hook and the language model share a
// process but not a module instance (see tier-store.ts), and the map survives
// realm boundaries the same way credentials do. It is in-memory only -- a
// process restart forgets the links, and a child request that arrives with an
// unknown session id simply resolves to itself (tier lookup then falls back
// to the request's own session, which a subagent never switched, i.e. the
// default tier). Acceptable: after a restart, a resumed 1M conversation needs
// one more "switch to 1M" anyway.

const ROOTS_KEY = "__opencode_qoder_session_parents";

const MAX_CHAIN_DEPTH = 16;

function parentMap(): Record<string, string> {
  const shared = globalThis as Record<string, unknown>;
  let map = shared[ROOTS_KEY] as Record<string, string> | undefined;
  if (!map) {
    map = {};
    shared[ROOTS_KEY] = map;
  }
  return map;
}

// Record a session's parent. Called from the event hook for every
// session.created. Re-recording the same pair is free.
export function recordSessionParent(sessionID: string, parentID: string | undefined): void {
  const id = String(sessionID ?? "").trim();
  if (id === "") return;
  const map = parentMap();
  const parent = String(parentID ?? "").trim();
  if (parent === "") {
    if (map[id]) {
      delete map[id];
      logPlugin(`session-roots: ${id} re-rooted`);
    }
    return;
  }
  if (map[id] === parent) return;
  map[id] = parent;
  // A session can only have one parent, so a cycle would need a bug here or a
  // hostile id collision; resolveRoot's depth guard covers it either way.
  logPlugin(`session-roots: ${id} -> ${parent}`);
}

// The session that owns the conversation: walk parent links until a root.
export function resolveRootSession(sessionID: string): string {
  const start = String(sessionID ?? "").trim();
  if (start === "") return start;
  const map = parentMap();
  let current = start;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    const parent = map[current];
    if (!parent || parent === current) return current;
    current = parent;
  }
  logPlugin(`session-roots: parent chain too deep from ${start}, using ${current}`);
  return current;
}

// Forget links to a gone session (event: session.deleted). Descendants re-
// resolve on their own; a stale link only costs one hop.
export function forgetSession(sessionID: string): void {
  const id = String(sessionID ?? "").trim();
  if (id === "") return;
  const map = parentMap();
  if (map[id]) delete map[id];
  for (const [child, parent] of Object.entries(map)) {
    if (parent === id) delete map[child];
  }
}
