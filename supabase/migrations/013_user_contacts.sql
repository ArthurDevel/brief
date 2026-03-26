-- Per-user contacts index for fuzzy contact lookup.
--
-- Stores contacts extracted from IMAP email headers so the voice agent
-- can resolve spoken names to email addresses.
--
-- - user_contacts table with RLS policies
-- - updated_at trigger (reuses existing update_updated_at function)
-- - contacts_synced_at column on user_settings for concurrent sync prevention

-- ============================================================================
-- TABLE
-- ============================================================================

create table user_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  frequency integer default 1,
  last_seen_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint user_contacts_user_email_unique unique (user_id, email)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create index idx_user_contacts_user_id on user_contacts(user_id);

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

create trigger user_contacts_updated_at
  before update on user_contacts
  for each row
  execute function update_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table user_contacts enable row level security;

create policy "Users can view their own contacts"
  on user_contacts for select
  using (auth.uid() = user_id);

create policy "Users can insert their own contacts"
  on user_contacts for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own contacts"
  on user_contacts for update
  using (auth.uid() = user_id);

create policy "Users can delete their own contacts"
  on user_contacts for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- ADD contacts_synced_at TO user_settings
-- ============================================================================

alter table user_settings add column contacts_synced_at timestamptz;
