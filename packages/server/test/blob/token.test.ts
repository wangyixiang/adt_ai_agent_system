import { describe, it, expect } from "vitest";
import { createBlobTokenSigner } from "../../src/blob/token";

describe("blob token signer", () => {
  const signer = createBlobTokenSigner("test-secret");
  const claims = {
    contentRef: "blob_a",
    direction: "upload" as const,
    userId: "usr_1",
    expiresAt: 5000,
  };

  it("verifies its own token", () => {
    expect(signer.verify(signer.sign(claims))).toEqual(claims);
  });

  it("rejects a tampered payload", () => {
    const [payload, mac] = signer.sign(claims).split(".") as [string, string];
    expect(signer.verify(`${payload}x.${mac}`)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    expect(createBlobTokenSigner("other-secret").verify(signer.sign(claims))).toBeNull();
  });

  it("rejects a structure it never produced", () => {
    for (const token of ["", "no-dot", "a.b", "a.b.c"]) {
      expect(signer.verify(token)).toBeNull();
    }
  });
});
