import {
  newContentRefId,
  newMessageId,
  nowUtcIso,
  PROTOCOL_VERSION,
} from "@adt/shared";
import { sendError } from "../ws/errors";
import type { MessageRouter } from "../ws/messageRouter";
import type { BlobConfig } from "./config";
import type { BlobRepository } from "./repository";
import type { BlobTokenSigner } from "./token";

export interface BlobProtocolDeps {
  router: MessageRouter;
  repository: BlobRepository;
  signer: BlobTokenSigner;
  config: BlobConfig;
  now?: () => number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `blob.allocate_request` → `blob.allocate_response` (PROTOCOL_SPEC.md §7.5).
 * The Server refuses early (media type, size, ownership) so a provider never
 * spends a 512 MiB upload on a rejection it could have learned at once, and it
 * hands back a signed URL because the transfer happens outside this connection.
 */
export function registerBlobProtocol(deps: BlobProtocolDeps): void {
  const { router, repository, signer, config } = deps;
  const now = deps.now ?? (() => Date.now());

  router.register("blob.allocate_request", async ({ conn, session }, env) => {
    if (!session) return;

    const payload = asRecord(env.payload);
    const reject = (reason: string): void =>
      sendError(conn, session, "blob_rejected", reason, env.message_id);

    const direction = payload.direction;
    if (direction !== "upload" && direction !== "download") {
      reject(`unsupported direction: ${String(direction)}`);
      return;
    }

    const at = now();
    let contentRef: string;
    let mediaType: string;
    let size: number;
    let sha256: string;

    if (direction === "upload") {
      const name = payload.name;
      const candidateMedia = payload.media_type;
      const candidateSize = payload.size;
      const candidateSha256 = payload.sha256;

      if (typeof name !== "string" || name.length === 0) {
        reject("upload requires a name");
        return;
      }
      if (typeof candidateMedia !== "string" || !config.allowedMediaTypes.has(candidateMedia)) {
        reject(`media_type is not allowed: ${String(candidateMedia)}`);
        return;
      }
      if (
        typeof candidateSize !== "number" ||
        !Number.isInteger(candidateSize) ||
        candidateSize <= 0
      ) {
        reject("upload requires a positive integer size");
        return;
      }
      if (candidateSize > config.maxBlobBytes) {
        reject(`size exceeds the ${config.maxBlobBytes} byte limit`);
        return;
      }
      if (typeof candidateSha256 !== "string" || !SHA256_HEX.test(candidateSha256)) {
        reject("upload requires a lowercase hex sha256");
        return;
      }

      contentRef = newContentRefId();
      mediaType = candidateMedia;
      size = candidateSize;
      sha256 = candidateSha256;
      await repository.create({
        contentRef,
        ownerUserId: session.userId,
        direction,
        name,
        mediaType,
        size,
        sha256,
        createdAt: at,
        expiresAt: at + config.retentionMs,
        committedAt: null,
      });
    } else {
      const requested = payload.content_ref;
      if (typeof requested !== "string") {
        reject("download requires content_ref");
        return;
      }

      const row = await repository.get(requested);
      // One answer for "no such ref", "not yours" and "never uploaded": a
      // refusal must not become an oracle for refs the caller may not use.
      if (!row || row.ownerUserId !== session.userId || row.committedAt === null) {
        reject("unknown or unavailable content_ref");
        return;
      }

      contentRef = row.contentRef;
      mediaType = row.mediaType;
      size = row.size;
      sha256 = row.sha256;
    }

    const expiresAt = at + config.tokenTtlMs;
    const token = signer.sign({
      contentRef,
      direction,
      userId: session.userId,
      expiresAt,
    });

    conn.send({
      protocol_version: PROTOCOL_VERSION,
      message_id: newMessageId(),
      session_id: session.id,
      workflow_id: null,
      user_id: session.userId,
      type: "blob.allocate_response",
      ts: nowUtcIso(),
      in_reply_to: env.message_id,
      payload: {
        content_ref: contentRef,
        url: `${config.baseUrl()}/blob/${contentRef}?token=${token}`,
        expires_at: new Date(expiresAt).toISOString(),
        // Echoed so a client can build the reference without re-deriving it.
        media_type: mediaType,
        size,
        sha256,
      },
    });
  });
}
