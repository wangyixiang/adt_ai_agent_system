import type { FastifyInstance } from "fastify";
import type { BlobConfig } from "./config";
import type { BlobRepository } from "./repository";
import { BlobIntegrityError, type BlobStore } from "./store";
import type { BlobTokenClaims, BlobTokenSigner } from "./token";

export interface BlobHttpDeps {
  repository: BlobRepository;
  store: BlobStore;
  signer: BlobTokenSigner;
  config: BlobConfig;
  now?: () => number;
}

interface BlobParams {
  contentRef: string;
}

interface BlobQuery {
  token?: string;
}

/**
 * The blob channel's transport (PROTOCOL_SPEC.md §7.5): the bytes travel on
 * their own URL, never inside the protocol connection. Both routes stream, so
 * the configured maximum never has to fit in memory, and the URL is the only
 * credential — verified against the same secret that signed it.
 */
export function registerBlobRoutes(app: FastifyInstance, deps: BlobHttpDeps): void {
  const { repository, store, signer, config } = deps;
  const now = deps.now ?? (() => Date.now());

  // Fastify rejects content types it cannot parse (415), and a blob is
  // arbitrary bytes. This hands the raw stream straight to the handler instead
  // of buffering it — the protocol route is WebSocket, so no JSON body route
  // depends on the default parser here.
  app.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });

  const authorize = (
    query: BlobQuery,
    contentRef: string,
    direction: "upload" | "download",
  ): BlobTokenClaims | null => {
    const claims = query.token ? signer.verify(query.token) : null;
    if (!claims) return null;
    if (claims.direction !== direction) return null;
    if (claims.contentRef !== contentRef) return null;
    if (claims.expiresAt <= now()) return null;
    return claims;
  };

  app.put<{ Params: BlobParams; Querystring: BlobQuery }>(
    "/blob/:contentRef",
    async (request, reply) => {
      const { contentRef } = request.params;
      const claims = authorize(request.query, contentRef, "upload");
      if (!claims) return reply.code(401).send({ error: "invalid_token" });

      const row = await repository.get(contentRef);
      if (!row || row.ownerUserId !== claims.userId) {
        return reply.code(404).send({ error: "unknown_blob" });
      }
      if (row.committedAt !== null) {
        return reply.code(409).send({ error: "already_committed" });
      }

      try {
        const written = await store.write(request.raw, {
          sha256: row.sha256,
          size: row.size,
          maxBytes: config.maxBlobBytes,
        });
        // Only now is the reference safe to write into evidence: the row is
        // committed once the bytes are verified and in place.
        await repository.commit(contentRef, now());
        return reply.code(201).send({
          content_ref: contentRef,
          size: written.size,
          sha256: written.sha256,
        });
      } catch (error) {
        if (error instanceof BlobIntegrityError) {
          // The row stays uncommitted; expiry collection cleans it up.
          return reply.code(400).send({ error: "integrity", message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: BlobParams; Querystring: BlobQuery }>(
    "/blob/:contentRef",
    async (request, reply) => {
      const { contentRef } = request.params;
      const claims = authorize(request.query, contentRef, "download");
      if (!claims) return reply.code(401).send({ error: "invalid_token" });

      const row = await repository.get(contentRef);
      // "Not there", "not yours" and "never uploaded" answer the same way: a
      // refusal must not reveal which refs exist.
      if (!row || row.committedAt === null || row.ownerUserId !== claims.userId) {
        return reply.code(404).send({ error: "unknown_blob" });
      }

      const body = await store.read(row.sha256);
      if (!body) return reply.code(404).send({ error: "unknown_blob" });

      return reply
        .code(200)
        .header("content-type", row.mediaType)
        .header("content-length", String(row.size))
        .header("etag", `"${row.sha256}"`)
        .header("x-blob-sha256", row.sha256)
        .send(body);
    },
  );
}
