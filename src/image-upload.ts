import crypto from "node:crypto";
import { buildAuthHeaders, type CosyCredentials } from "./cosy.js";
import { logPlugin } from "./log.js";

// Qoder does not carry raster bytes inside a model request: the client
// publishes each request image to the center service once and then references
// the returned URL. Sending the bytes inline as a base64 data URL still works
// (the gateway accepts it), but it inflates every request by ~33% and repeats
// the payload on every turn of the conversation, because the prompt is resent
// whole each time. Publishing once and referencing the URL keeps the request
// small and lets the gateway's cache key stay stable.
//
// The contract is deliberately fail-open: an upload problem (network, timeout,
// rejection, odd response) degrades to the inline data URL, so a turn always
// completes with the same content it would have carried before this module
// existed. Nothing here may turn an upload failure into a failed model call.

const UPLOAD_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_CAPACITY = 512;
const CONCURRENCY = 4;

// Center service, not the chat endpoint: uploads live beside the other center
// APIs (refresh_token, userinfo), not on the chat host. The HTTP path carries
// the `/algo` prefix, but the SIGNATURE path must not -- computeSigPath() in
// cosy.ts strips it, which is why the signed URL goes through that helper.
// The client also passes a `request_id` query parameter, so the request needs
// one to match the reference implementation.
// References: qodercli's image publication, dsh-provider-qoder's
// getQoderImageUploadUrl() + buildQoderImageMultipart().
export const QODER_IMAGE_UPLOAD_PATH = "/api/v2/image/upload";
const UPLOAD_HTTP_PATH = `/algo${QODER_IMAGE_UPLOAD_PATH}`;

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface CacheEntry {
  url: string;
  expiresAt: number;
}

// Keyed by content digest, so the same screenshot pasted twice (or re-sent on
// the following turn) publishes once. Module-level rather than per-instance:
// opencode loads the plugin twice per process and both realms would otherwise
// publish the same bytes separately.
const urlCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | undefined>>();
let activeUploads = 0;
const uploadQueue: Array<() => void> = [];

function digest(data: Uint8Array, mediaType: string): string {
  return crypto.createHash("sha256").update(mediaType).update(data).digest("hex");
}

function cacheGet(key: string): string | undefined {
  const entry = urlCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    urlCache.delete(key);
    return undefined;
  }
  // Refresh recency so a long conversation does not evict the images it is
  // still referencing.
  urlCache.delete(key);
  urlCache.set(key, entry);
  return entry.url;
}

function cacheSet(key: string, url: string): void {
  if (urlCache.size >= CACHE_CAPACITY) {
    const oldest = urlCache.keys().next();
    if (!oldest.done) urlCache.delete(oldest.value);
  }
  urlCache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function acquireSlot(): Promise<void> {
  if (activeUploads < CONCURRENCY) {
    activeUploads++;
    return;
  }
  await new Promise<void>((resolve) => uploadQueue.push(resolve));
  activeUploads++;
}

function releaseSlot(): void {
  activeUploads--;
  uploadQueue.shift()?.();
}

/**
 * Encode one image as a single-field multipart payload using the boundary
 * shape the Qoder client itself emits. The exact bytes matter: the gateway
 * validates the multipart body against the COSY signature.
 */
export function buildQoderImageMultipart(
  data: Uint8Array,
  mediaType: string,
  boundaryId: string = crypto.randomUUID(),
): { body: Buffer; boundary: string } {
  const boundary = `----qodercli-${boundaryId}`;
  const extension = MEDIA_TYPE_EXTENSIONS[mediaType] ?? "png";
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="image.${extension}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([header, Buffer.from(data), footer]), boundary };
}

/**
 * Extract the durable URL from a center upload response. The service has
 * answered with the URL at several nesting depths across versions, so all
 * observed shapes are accepted; an unrecognised body reads as "no URL" and
 * the caller falls back to inline bytes.
 */
export function readQoderImageUrl(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const result = root.result as Record<string, unknown> | undefined;
  const data = root.data as Record<string, unknown> | undefined;
  for (const candidate of [root.url, result?.url, result?.oss_url, data?.url, data?.oss_url]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (!URL.canParse(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

export interface ImageUploadContext {
  /** Credential the COSY signature is built from. */
  creds: CosyCredentials;
  signal?: AbortSignal;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

// Center service host the upload path hangs off. Defaults to the global center;
// the China region will pass its own.
const DEFAULT_CENTER_URL = "https://center.qoder.sh";

/**
 * Publish one image and return its URL, or undefined when publication failed
 * for any reason. Never throws: every failure path degrades to the caller's
 * inline fallback.
 */
async function publish(
  data: Uint8Array,
  mediaType: string,
  context: ImageUploadContext,
): Promise<string | undefined> {
  const requestId = crypto.randomUUID();
  const { body, boundary } = buildQoderImageMultipart(data, mediaType);
  const url = `${DEFAULT_CENTER_URL}${UPLOAD_HTTP_PATH}?request_id=${encodeURIComponent(requestId)}`;
  // The Qoder client signs the body LENGTH, not the body: its prepareRequest
  // receives String(body.length). Signing the raw multipart bytes would be
  // wrong -- and would corrupt them, because the signature input is assembled
  // as text. buildAuthHeaders hashes whatever it is handed, so hand it the
  // length string. Note the signature PATH drops the `/algo` prefix, which
  // computeSigPath() in cosy.ts already strips from the URL given here, while
  // the HTTP URL keeps it.
  const signedBody = Buffer.from(String(body.length), "utf8");
  const headers = buildAuthHeaders(signedBody, url, context.creds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) onAbort();
  else context.signal?.addEventListener("abort", onAbort, { once: true });
  const doFetch = context.fetchImpl ?? fetch;
  try {
    const response = await doFetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        accept: "application/json",
        "AI-CLIENT-TIMESTAMP": String(Math.floor(Date.now() / 1000)),
        ...headers,
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      logPlugin(`image-upload: ${response.status} for ${mediaType} (${data.length} bytes)`);
      return undefined;
    }
    return readQoderImageUrl(await response.json().catch(() => undefined));
  } catch (error) {
    logPlugin(`image-upload: failed for ${mediaType} -- ${(error as Error)?.message ?? "?"}`);
    return undefined;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Publish an image with content-addressed caching and single-flight sharing:
 * concurrent turns referencing the same bytes (the common case when a
 * conversation resends its history) await one publication.
 *
 * @returns the published URL, or undefined to use the inline data URL.
 */
export async function uploadQoderImage(
  data: Uint8Array,
  mediaType: string,
  context: ImageUploadContext,
): Promise<string | undefined> {
  if (data.length === 0) return undefined;
  const key = digest(data, mediaType);
  const cached = cacheGet(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const flight = (async () => {
    await acquireSlot();
    try {
      const url = await publish(data, mediaType, context);
      if (url) cacheSet(key, url);
      return url;
    } finally {
      releaseSlot();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, flight);
  return flight;
}

/** Test seam: drop the content cache and any in-flight flights. */
export function __resetImageUploadCache(): void {
  urlCache.clear();
  inFlight.clear();
}
