CREATE TABLE IF NOT EXISTS workflows (
  id                text PRIMARY KEY,
  user_id           text NOT NULL,
  session_id        text NOT NULL,
  state             text NOT NULL,
  terminal_reason   text,
  criteria          jsonb NOT NULL,
  created_at        bigint NOT NULL,
  ended_at          bigint,
  not_solved_rounds integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS workflows_user_id_idx ON workflows (user_id);
CREATE INDEX IF NOT EXISTS workflows_session_id_idx ON workflows (session_id);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id               text PRIMARY KEY,
  workflow_id      text NOT NULL REFERENCES workflows (id),
  state            text NOT NULL,
  objective        text NOT NULL,
  capability       text NOT NULL,
  side_effect      boolean NOT NULL,
  interruptible    boolean NOT NULL,
  idempotency_key  text,
  attempt          integer NOT NULL DEFAULT 1,
  wait_class       text
);

CREATE INDEX IF NOT EXISTS workflow_steps_workflow_id_idx ON workflow_steps (workflow_id);

CREATE TABLE IF NOT EXISTS workflow_events (
  id          text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows (id),
  kind        text NOT NULL,
  ts          bigint NOT NULL,
  payload     jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_events_workflow_ts_idx ON workflow_events (workflow_id, ts);
