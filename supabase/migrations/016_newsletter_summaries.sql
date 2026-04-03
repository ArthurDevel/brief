-- Newsletter summary feature: daily LLM-powered digests of subscribed newsletters.
--
-- - Adds newsletter_config JSONB column to user_settings (stores enabled flag, sender list, custom prompt)
-- - Creates newsletter_summaries table with RLS policies
-- - Unique constraint on (user_id, summary_date) for idempotent upserts

-- ============================================================================
-- ADD newsletter_config TO user_settings
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'user_settings' and column_name = 'newsletter_config'
  ) then
    alter table user_settings add column newsletter_config jsonb;
  end if;
end $$;

-- ============================================================================
-- TABLE
-- ============================================================================

create table if not exists newsletter_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  summary_date date not null,
  summary text not null,
  email_count integer not null default 0,
  listened boolean not null default false,
  listened_at timestamptz,
  created_at timestamptz not null default now(),

  constraint newsletter_summaries_user_date_unique unique (user_id, summary_date)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create index if not exists idx_newsletter_summaries_user_id on newsletter_summaries(user_id);
create index if not exists idx_newsletter_summaries_user_date on newsletter_summaries(user_id, summary_date);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table newsletter_summaries enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'Users can view their own newsletter summaries' and tablename = 'newsletter_summaries') then
    create policy "Users can view their own newsletter summaries" on newsletter_summaries for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can update their own newsletter summaries' and tablename = 'newsletter_summaries') then
    create policy "Users can update their own newsletter summaries" on newsletter_summaries for update using (auth.uid() = user_id);
  end if;
end $$;
