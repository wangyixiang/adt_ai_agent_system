import { createHmac, timingSafeEqual } from "node:crypto";
import type { BlobDirection } from "@adt/shared";

export interface BlobTokenClaims {
  contentRef: string;
  direction: BlobDirection;
  userId: string;
  expiresAt: number;
}

export interface BlobTokenSigner {
  sign(claims: BlobTokenClaims): string;
  /** Null when the token is malformed or the signature does not match. */
  verify(token: string): BlobTokenClaims | null;
}

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/**
 * A compact signed token for the blob URLs (PROTOCOL_SPEC.md §7.5: "带鉴权、
 * 有生命周期"). Deliberately stateless — the Server keeps no session for an
 * issued URL, so a URL minted before a restart still works as long as the
 * secret is stable (`BLOB_SECRET`).
 *
 * Expiry is carried in the claims and enforced by the caller: this module only
 * answers "did we sign this, and what does it say".
 */
export function createBlobTokenSigner(secret: string): BlobTokenSigner {
  const mac = (payload: string): string =>
    createHmac("sha256", secret).update(payload).digest("base64url");

  return {
    sign(claims) {
      const payload = encode(JSON.stringify(claims));
      return `${payload}.${mac(payload)}`;
    },

    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [payload, signature] = parts as [string, string];

      const expected = Buffer.from(mac(payload), "utf8");
      const given = Buffer.from(signature, "utf8");
      // timingSafeEqual throws on length mismatch, so compare lengths first.
      if (expected.length !== given.length) return null;
      if (!timingSafeEqual(expected, given)) return null;

      try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
        if (typeof claims !== "object" || claims === null) return null;
        const { contentRef, direction, userId, expiresAt } = claims as Partial<BlobTokenClaims>;
        if (
          typeof contentRef !== "string" ||
          (direction !== "upload" && direction !== "download") ||
          typeof userId !== "string" ||
          typeof expiresAt !== "number"
        ) {
          return null;
        }
        return { contentRef, direction, userId, expiresAt };
      } catch {
        return null;
      }
    },
  };
}
