-- The Evidence `type` the Capability promised, frozen at dispatch next to the
-- output schema (CAPABILITY_SPEC.md §4.1/§5.2): the Server checks a step's
-- evidence against what was declared when it was dispatched, not against a
-- manifest that may have changed since.
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS expected_output text;
