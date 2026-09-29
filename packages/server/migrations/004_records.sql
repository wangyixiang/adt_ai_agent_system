-- One record per workflow is the invariant that makes finalize idempotent
-- (RECORD_SPEC.md §2, decision D-D3).
CREATE TABLE IF NOT EXISTS records (
  record_id      text PRIMARY KEY,
  workflow_id    text UNIQUE NOT NULL,
  owner_user_id  text NOT NULL,
  terminal_state text NOT NULL,
  ended_at       bigint NOT NULL,
  document       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS records_owner_ended_idx ON records (owner_user_id, ended_at DESC);
