-- Insertion-ordered event log. `ts` is a monotonic clock that resets across
-- restarts and can tie; P2b reconstructs Records in this order.
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS seq bigserial;
