CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
