-- Steps carry the input the planner produced, so it can be validated against
-- the Capability input schema and sent in step.dispatch (CAPABILITY_SPEC.md §5,
-- RECORD_SPEC.md §4).
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}'::jsonb;
