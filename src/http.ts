import { USER_AGENT } from "./constants.js";

// Shared HTTP scaffolding: only the parts repeated byte-for-byte across call
// sites. Response handling stays per-site because the endpoints disagree on
// what a non-2xx means (model list throws, quota fails open, userinfo is
// swallowed).

// Headers every JSON-expecting Qoder endpoint wants. The Accept/User-Agent
// pair used to be retyped at seven sites across three modules.
export function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Accept: "application/json", "User-Agent": USER_AGENT, ...extra };
}

// fetch() bounded by a timeout that covers the whole exchange, body read
// included. `handle` consumes the response while the signal is still armed, so
// a stalled body aborts exactly as the inline AbortController/timer/finally
// block it replaces did.
export async function fetchWithTimeout<T>(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  handle: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await handle(await fetch(url, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// Body consumed to text with a length cap for embedding in an error message.
// The cap matters: an upstream 413/5xx page is far too long to forward verbatim.
export async function readErrorBody(response: Response, limit = 200): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, limit);
}
