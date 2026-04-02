-- Create user_metadata table for storing per-user metadata (e.g. country waitlist preferences)

CREATE TABLE user_metadata (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  country_waitlist jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_metadata ENABLE ROW LEVEL SECURITY;
