import type { BlobDirection } from "@adt/shared";
import type { Pool } from "../db/pool";

/** One allocation: what was asked for, what it costs, and whether it landed. */
export interface BlobRecord {
  contentRef: string;
  ownerUserId: string;
  direction: BlobDirection;
  name: string | null;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  /** Null until the bytes are verified and in place. */
  committedAt: number | null;
}

export interface BlobRepository {
  create(record: BlobRecord): Promise<void>;
  get(contentRef: string): Promise<BlobRecord | null>;
  /** True when a row was actually committed (false: it vanished or was already done). */
  commit(contentRef: string, at: number): Promise<boolean>;
  listExpired(now: number): Promise<BlobRecord[]>;
  remove(contentRef: string): Promise<void>;
  /** Does any Record still cite this ref? Records are immutable, so it must stay readable. */
  isReferenced(contentRef: string): Promise<boolean>;
  /** Does another row still point at the same bytes (shared file)? */
  sharesBytes(sha256: string, exceptContentRef: string): Promise<boolean>;
}

interface BlobRow {
  content_ref: string;
  owner_user_id: string;
  direction: string;
  name: string | null;
  media_type: string;
  size: string | number;
  sha256: string;
  created_at: string | number;
  expires_at: string | number;
  committed_at: string | number | null;
}

const toRecord = (row: BlobRow): BlobRecord => ({
  contentRef: row.content_ref,
  ownerUserId: row.owner_user_id,
  direction: row.direction as BlobDirection,
  name: row.name,
  mediaType: row.media_type,
  size: Number(row.size),
  sha256: row.sha256,
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
  committedAt: row.committed_at === null ? null : Number(row.committed_at),
});

export class PostgresBlobRepository implements BlobRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: BlobRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO blobs (content_ref, owner_user_id, direction, name, media_type, size, sha256, created_at, expires_at, committed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        record.contentRef,
        record.ownerUserId,
        record.direction,
        record.name,
        record.mediaType,
        record.size,
        record.sha256,
        record.createdAt,
        record.expiresAt,
        record.committedAt,
      ],
    );
  }

  async get(contentRef: string): Promise<BlobRecord | null> {
    const result = await this.pool.query<BlobRow>("SELECT * FROM blobs WHERE content_ref = $1", [
      contentRef,
    ]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async commit(contentRef: string, at: number): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE blobs SET committed_at = $2 WHERE content_ref = $1 AND committed_at IS NULL",
      [contentRef, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listExpired(now: number): Promise<BlobRecord[]> {
    const result = await this.pool.query<BlobRow>(
      "SELECT * FROM blobs WHERE expires_at < $1 ORDER BY expires_at",
      [now],
    );
    return result.rows.map(toRecord);
  }

  async remove(contentRef: string): Promise<void> {
    await this.pool.query("DELETE FROM blobs WHERE content_ref = $1", [contentRef]);
  }

  async isReferenced(contentRef: string): Promise<boolean> {
    // A substring search over the stored document, not a parsed JSON walk: it
    // errs towards "referenced", which is the safe direction (a false positive
    // keeps a file; a false negative would break a Record's evidence). The
    // query always passes a full `blob_<uuid>`, so a prefix relationship would
    // be needed to fool it.
    //
    // `position()` rather than `LIKE`: a content_ref contains `_`, which LIKE
    // treats as a single-character wildcard.
    const result = await this.pool.query(
      "SELECT 1 FROM records WHERE position($1 in document::text) > 0 LIMIT 1",
      [contentRef],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async sharesBytes(sha256: string, exceptContentRef: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM blobs WHERE sha256 = $1 AND content_ref <> $2 LIMIT 1",
      [sha256, exceptContentRef],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
