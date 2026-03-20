-- Create private storage bucket for call recordings.
-- Only accessible via the service role key (Supabase dashboard).
-- No RLS policies are added for authenticated users.

INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', false);
