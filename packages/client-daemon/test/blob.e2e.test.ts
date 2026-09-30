import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { downloadBlob, uploadBlob } from "../src/blob";

describe("blob channel end to end", () => {
  it("uploads bytes as a content_ref and downloads the very same bytes", async () => {
    const srv = await startTestServer({});
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "blob-e2e", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    const bytes = Buffer.from("can trace line 1\nline 2\n");
    const ref = await uploadBlob(
      { connection: daemon.connection },
      { name: "can_trace.log", mediaType: "text/plain", bytes },
    );

    expect(ref.content_ref).toMatch(/^blob_/);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.size).toBe(bytes.length);

    // The server agrees the bytes are in place, and the owner can fetch them.
    expect((await srv.blobs.repository.get(ref.content_ref))!.committedAt).not.toBeNull();
    const back = await downloadBlob({ connection: daemon.connection }, ref.content_ref);
    expect(back.equals(bytes)).toBe(true);

    await daemon.close();
    await srv.close();
  });

  it("surfaces a refusal instead of pretending the upload happened", async () => {
    const srv = await startTestServer({});
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "blob-e2e", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    await expect(
      uploadBlob(
        { connection: daemon.connection },
        { name: "evil.bin", mediaType: "application/x-evil", bytes: Buffer.from("x") },
      ),
    ).rejects.toThrow(/blob_rejected/);

    await daemon.close();
    await srv.close();
  });
});
