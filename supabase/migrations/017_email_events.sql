-- email_events: tracks which engagement emails have been sent to each user.
-- Unique constraint on (user_id, email_type) prevents duplicate sends.
-- No RLS needed -- only accessed via service role client.

create table email_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email_type text not null,
  resend_email_id text,
  sent_at timestamptz default now(),

  constraint email_events_user_type_unique unique (user_id, email_type)
);

create index idx_email_events_user_id on email_events(user_id);
