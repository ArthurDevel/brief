-- Create private storage bucket for session logs.
-- Only accessible via the service role key (Supabase dashboard).
-- No RLS policies are added for authenticated users.

INSERT INTO storage.buckets (id, name, public)
VALUES ('session-logs', 'session-logs', false);
