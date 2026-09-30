-- Steps carry their own timing so the Server can enforce step_timeout without
-- consulting the live Capability registry (PROTOCOL_SPEC.md §9):
--   updated_at  last state change, used as the deadline base
--   timeout_ms  deadline snapshotted at dispatch from the capability's
--               timeout_hint (0 = no timeout)
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS timeout_ms bigint NOT NULL DEFAULT 0;
