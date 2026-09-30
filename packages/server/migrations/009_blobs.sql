-- Blob metadata (PROTOCOL_SPEC.md §7.5): one row per allocation, so an upload
-- can be refused early, a download can be authorised, and expiry can be swept
-- without walking the filesystem.
CREATE TABLE IF NOT EXISTS blobs (
  content_ref   text PRIMARY KEY,
  owner_user_id text NOT NULL,
  direction     text NOT NULL,
  name          text,
  media_type    text NOT NULL,
  size          bigint NOT NULL,
  sha256        text NOT NULL,
  created_at    bigint NOT NULL,
  expires_at    bigint NOT NULL,
  committed_at  bigint
);

CREATE INDEX IF NOT EXISTS blobs_expiry_idx ON blobs (expires_at);
-- Two refs may share bytes (the same log uploaded twice); the sweeper checks
-- this before deleting a file.
CREATE INDEX IF NOT EXISTS blobs_sha_idx ON blobs (sha256);
