-- Per-user Composio connection records for toolkits used outside the main dashboard.
--
-- Responsibilities:
-- - Store one Gmail-first Composio connection per user
-- - Track connection status and the linked Composio connected account
-- - Keep room for future toolkits without overloading user_email_accounts

-- ============================================================================
-- TABLE
-- ============================================================================

create table if not exists user_composio_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  toolkit text not null,
  provider text not null default 'composio',
  connected_account_id text,
  status text not null default 'connected',
  external_user_id text,
  connected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint user_composio_connections_provider_check
    check (provider in ('composio')),

  constraint user_composio_connections_status_check
    check (status in ('connected', 'reconnect_required', 'pending', 'error'))
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create unique index if not exists idx_user_composio_connections_user_toolkit
  on user_composio_connections (user_id, toolkit);

create unique index if not exists idx_user_composio_connections_connected_account_id
  on user_composio_connections (connected_account_id)
  where connected_account_id is not null;

create index if not exists idx_user_composio_connections_user_id
  on user_composio_connections (user_id);

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'user_composio_connections_updated_at'
  ) then
    create trigger user_composio_connections_updated_at
      before update on user_composio_connections
      for each row
      execute function update_updated_at();
  end if;
end $$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table user_composio_connections enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where policyname = 'Users can view their own Composio connections'
      and tablename = 'user_composio_connections'
  ) then
    create policy "Users can view their own Composio connections"
      on user_composio_connections
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where policyname = 'Users can insert their own Composio connections'
      and tablename = 'user_composio_connections'
  ) then
    create policy "Users can insert their own Composio connections"
      on user_composio_connections
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where policyname = 'Users can update their own Composio connections'
      and tablename = 'user_composio_connections'
  ) then
    create policy "Users can update their own Composio connections"
      on user_composio_connections
      for update
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where policyname = 'Users can delete their own Composio connections'
      and tablename = 'user_composio_connections'
  ) then
    create policy "Users can delete their own Composio connections"
      on user_composio_connections
      for delete
      using (auth.uid() = user_id);
  end if;
end $$;
