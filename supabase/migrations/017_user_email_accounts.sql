-- Per-user email account connections (custom IMAP/SMTP or Unipile-backed).
--
-- This table replaces the email-related columns in user_settings as the
-- source of truth for mailbox connectivity.
--
-- Responsibilities:
-- - Store provider type, connection mode, and status for each mailbox
-- - Reference Vault-stored IMAP/SMTP secrets for custom accounts
-- - Reference Unipile account IDs for Gmail/Outlook accounts
-- - Enforce one active account per user via partial unique index
-- - Backfill existing custom accounts from user_settings

-- ============================================================================
-- TABLE
-- ============================================================================

create table if not exists user_email_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  provider text not null,
  connection_type text not null,

  email_address text,
  unipile_account_id text,

  status text not null default 'pending',
  last_error text,

  -- Custom IMAP/SMTP fields (null for Unipile-backed accounts)
  imap_host text,
  imap_port integer,
  imap_user text,
  imap_password_secret_id uuid,
  smtp_host text,
  smtp_port integer,
  smtp_user text,
  smtp_password_secret_id uuid,

  is_active boolean not null default true,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Valid providers
  constraint user_email_accounts_provider_check
    check (provider in ('gmail', 'outlook', 'custom')),

  -- Valid connection types
  constraint user_email_accounts_connection_type_check
    check (connection_type in ('unipile', 'imap_smtp')),

  -- Valid statuses
  constraint user_email_accounts_status_check
    check (status in ('connected', 'reconnect_required', 'pending', 'error')),

  -- Gmail/Outlook must use Unipile, custom must use IMAP/SMTP
  constraint user_email_accounts_provider_connection_check
    check (
      (provider in ('gmail', 'outlook') and connection_type = 'unipile')
      or (provider = 'custom' and connection_type = 'imap_smtp')
    )
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Enforce one active account per user
create unique index if not exists idx_user_email_accounts_one_active
  on user_email_accounts (user_id)
  where is_active = true;

create index if not exists idx_user_email_accounts_user_id
  on user_email_accounts (user_id);

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'user_email_accounts_updated_at'
  ) then
    create trigger user_email_accounts_updated_at
      before update on user_email_accounts
      for each row
      execute function update_updated_at();
  end if;
end $$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table user_email_accounts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'Users can view their own email accounts' and tablename = 'user_email_accounts') then
    create policy "Users can view their own email accounts" on user_email_accounts for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can insert their own email accounts' and tablename = 'user_email_accounts') then
    create policy "Users can insert their own email accounts" on user_email_accounts for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can update their own email accounts' and tablename = 'user_email_accounts') then
    create policy "Users can update their own email accounts" on user_email_accounts for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can delete their own email accounts' and tablename = 'user_email_accounts') then
    create policy "Users can delete their own email accounts" on user_email_accounts for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ============================================================================
-- BACKFILL FROM user_settings
-- ============================================================================

-- Copy existing custom IMAP/SMTP accounts from user_settings into the new table.
-- Only rows that have imap_host configured are treated as having an email account.
insert into user_email_accounts (
  user_id,
  provider,
  connection_type,
  email_address,
  status,
  is_active,
  imap_host,
  imap_port,
  imap_user,
  imap_password_secret_id,
  smtp_host,
  smtp_port,
  smtp_user,
  smtp_password_secret_id,
  connected_at
)
select
  us.user_id,
  'custom',
  'imap_smtp',
  us.imap_user,
  'connected',
  true,
  us.imap_host,
  us.imap_port,
  us.imap_user,
  us.imap_password_secret_id,
  us.smtp_host,
  us.smtp_port,
  us.smtp_user,
  us.smtp_password_secret_id,
  now()
from user_settings us
where us.imap_host is not null
-- Skip users who already have an active email account (idempotent re-run)
and not exists (
  select 1 from user_email_accounts uea
  where uea.user_id = us.user_id and uea.is_active = true
);
