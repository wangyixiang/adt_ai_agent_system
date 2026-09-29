-- The original user request must survive a restart so the Record keeps its
-- problem statement (RECORD_SPEC.md §1/§3). Previously it lived only in memory.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS user_request jsonb NOT NULL DEFAULT '{}'::jsonb;
