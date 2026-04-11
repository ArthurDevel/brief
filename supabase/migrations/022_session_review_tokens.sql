-- session_review_tokens: short-lived bearer tokens for session recap review links.
-- Only service-role server code should access this table.

create table session_review_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_session_review_tokens_session_id on session_review_tokens(session_id);
create index idx_session_review_tokens_user_session on session_review_tokens(user_id, session_id);
create index idx_session_review_tokens_expires_at on session_review_tokens(expires_at);

alter table session_review_tokens enable row level security;
