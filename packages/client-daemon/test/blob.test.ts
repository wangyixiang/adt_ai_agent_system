import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { downloadBlob, uploadBlob } from "../src/blob";

/** Minimal stand-in for `DaemonConnection.request`, so the helper is tested alone. */
const connection = (payload: Record<string, unknown>) => ({
  request: async (): Promise<Record<string, unknown>> => payload,
});

const bytes = Buffer.from("can trace\n");
const sha = createHash("sha256").update(bytes).digest("hex");

const response = (body: Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers });

describe("blob client helper", () => {
  it("sends the declared type and sha to the server and trusts its 2xx", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return response(Buffer.from("{\"ok\":true}"), { "content-type": "application/json" });
    }) as unknown as typeof fetch;

    const ref = await uploadBlob(
      {
        connection: connection({
          content_ref: "blob_a",
          url: "http://blob.test/blob/blob_a?token=t",
        }) as never,
        fetchImpl,
      },
      { name: "can_trace.log", mediaType: "text/plain", bytes },
    );

    expect(ref).toEqual({
      content_ref: "blob_a",
      media_type: "text/plain",
      size: bytes.length,
      sha256: sha,
      name: "can_trace.log",
    });
    expect(sent[0]!.url).toBe("http://blob.test/blob/blob_a?token=t");
    expect((sent[0]!.init.headers as Record<string, string>)["content-type"]).toBe("text/plain");
  });

  it("reports a refused upload instead of a reference", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;

    await expect(
      uploadBlob(
        {
          connection: connection({
            content_ref: "blob_a",
            url: "http://blob.test/blob/blob_a?token=t",
          }) as never,
          fetchImpl,
        },
        { name: "x", mediaType: "text/plain", bytes },
      ),
    ).rejects.toThrow(/upload failed: 400/);
  });

  it("refuses bytes that do not match the sha the server reported sending", async () => {
    const fetchImpl = (async () =>
      response(Buffer.from("tampered"), { "x-blob-sha256": sha })) as unknown as typeof fetch;

    await expect(
      downloadBlob(
        {
          connection: connection({
            content_ref: "blob_a",
            url: "http://blob.test/blob/blob_a?token=t",
          }) as never,
          fetchImpl,
        },
        "blob_a",
      ),
    ).rejects.toThrow(/sha256 mismatch/);
  });
});
