-- Snapshot of the Capability's output schema at dispatch, so a step's returned
-- evidence is validated against what the client declared at that moment
-- (CAPABILITY_SPEC.md §4.1: capability changes only affect future dispatches).
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS output_schema jsonb;
