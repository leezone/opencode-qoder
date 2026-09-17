import { describe, expect, it } from "vitest";
import type { CosyCredentials } from "../cosy.js";
import {
  __resetImageUploadCache,
  buildQoderImageMultipart,
  readQoderImageUrl,
  uploadQoderImage,
} from "../image-upload.js";

const creds: CosyCredentials = {
  userID: "user-1",
  authToken: "token-1",
  name: "Test",
  email: "t@example.com",
  machineID: "machine-1",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildQoderImageMultipart", () => {
  it("emits the qodercli boundary shape with a single file field", () => {
    const { body, boundary } = buildQoderImageMultipart(
      new Uint8Array([1, 2, 3]),
      "image/png",
      "abc",
    );
    expect(boundary).toBe("----qodercli-abc");
    const text = body.toString("latin1");
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="image.png"');
    expect(text).toContain("Content-Type: image/png");
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it("maps known media types to the right extension", () => {
    expect(
      buildQoderImageMultipart(new Uint8Array([1]), "image/jpeg", "b").body.toString(),
    ).toContain('filename="image.jpg"');
    expect(
      buildQoderImageMultipart(new Uint8Array([1]), "image/webp", "c").body.toString(),
    ).toContain('filename="image.webp"');
  });
});

describe("readQoderImageUrl", () => {
  it("accepts every shape the center service has used", () => {
    expect(readQoderImageUrl({ url: "https://x.test/a.png" })).toBe("https://x.test/a.png");
    expect(readQoderImageUrl({ result: { url: "https://x.test/b.png" } })).toBe(
      "https://x.test/b.png",
    );
    expect(readQoderImageUrl({ result: { oss_url: "https://x.test/c.png" } })).toBe(
      "https://x.test/c.png",
    );
    expect(readQoderImageUrl({ data: { oss_url: "https://x.test/d.png" } })).toBe(
      "https://x.test/d.png",
    );
  });

  it("rejects non-URLs and empty bodies", () => {
    expect(readQoderImageUrl(null)).toBeUndefined();
    expect(readQoderImageUrl("nope")).toBeUndefined();
    expect(readQoderImageUrl({ url: "not-a-url" })).toBeUndefined();
    expect(readQoderImageUrl({ url: "   " })).toBeUndefined();
    expect(readQoderImageUrl({ result: {} })).toBeUndefined();
  });
});

describe("uploadQoderImage", () => {
  it("publishes the bytes and returns the URL", async () => {
    __resetImageUploadCache();
    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("Authorization"),
      });
      return jsonResponse({ result: { url: "https://cdn.test/img-1.png" } });
    }) as typeof fetch;

    const url = await uploadQoderImage(new Uint8Array([1, 2, 3]), "image/png", {
      creds,
      fetchImpl,
    });
    expect(url).toBe("https://cdn.test/img-1.png");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    // The HTTP path carries /algo and a request_id query parameter.
    expect(seen[0].url).toContain("/algo/api/v2/image/upload?request_id=");
    expect(seen[0].auth).toMatch(/^Bearer COSY\./);
  });

  it("signs the body LENGTH, not the raw multipart bytes", async () => {
    __resetImageUploadCache();
    let capturedLength: string | null = null;
    let capturedHash: string | null = null;
    let sentBytes = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedLength = headers.get("Cosy-Bodylength");
      capturedHash = headers.get("Cosy-Bodyhash");
      sentBytes = (init?.body as Uint8Array).length;
      return jsonResponse({ url: "https://cdn.test/x.png" });
    }) as typeof fetch;

    await uploadQoderImage(new Uint8Array([1, 2, 3, 4, 5]), "image/png", { creds, fetchImpl });

    // The multipart body actually sent is far longer than the signed value;
    // the signed value must be the ASCII digits of that body's byte length,
    // which is what qodercli's prepareRequest hands the signer.
    const signed = Buffer.from(String(sentBytes), "utf8");
    expect(capturedLength).toBe(String(signed.length));
    const { createHash } = await import("node:crypto");
    expect(capturedHash).toBe(createHash("md5").update(signed).digest("hex"));
    // Distinguish the two readings: the signed value is the handful of ASCII
    // digits of the length, not the ~200-byte multipart body.
    expect(signed.length).toBeLessThan(8);
    expect(sentBytes).toBeGreaterThan(signed.length * 10);
  });

  it("caches by content digest so repeat turns publish once", async () => {
    __resetImageUploadCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ url: "https://cdn.test/cached.png" });
    }) as typeof fetch;

    const a = await uploadQoderImage(new Uint8Array([9, 9]), "image/png", { creds, fetchImpl });
    const b = await uploadQoderImage(new Uint8Array([9, 9]), "image/png", { creds, fetchImpl });
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("single-flights concurrent publications of the same bytes", async () => {
    __resetImageUploadCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ url: "https://cdn.test/shared.png" });
    }) as typeof fetch;

    const results = await Promise.all([
      uploadQoderImage(new Uint8Array([7, 7]), "image/png", { creds, fetchImpl }),
      uploadQoderImage(new Uint8Array([7, 7]), "image/png", { creds, fetchImpl }),
      uploadQoderImage(new Uint8Array([7, 7]), "image/png", { creds, fetchImpl }),
    ]);
    expect(results).toEqual([
      "https://cdn.test/shared.png",
      "https://cdn.test/shared.png",
      "https://cdn.test/shared.png",
    ]);
    expect(calls).toBe(1);
  });

  it("fails open: an HTTP error yields undefined, never a throw", async () => {
    __resetImageUploadCache();
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(
      uploadQoderImage(new Uint8Array([1]), "image/png", { creds, fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("fails open: a network rejection yields undefined", async () => {
    __resetImageUploadCache();
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(
      uploadQoderImage(new Uint8Array([2]), "image/png", { creds, fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it("fails open: a 200 with no usable URL yields undefined", async () => {
    __resetImageUploadCache();
    const fetchImpl = (async () => jsonResponse({ result: {} })) as typeof fetch;
    await expect(
      uploadQoderImage(new Uint8Array([3]), "image/png", { creds, fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
