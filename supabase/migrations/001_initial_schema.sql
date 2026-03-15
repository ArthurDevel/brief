-- Initial database schema for the Voice Email Assistant.
--
-- Creates 7 tables with RLS policies:
-- 1. user_settings    -- IMAP/SMTP config, phone number, voice, approval config, PIN
-- 2. user_memory      -- key-value memory entries per user
-- 3. sessions         -- call session records with transcript and usage
-- 4. actions          -- tool call action queue with undo support
-- 5. feature_requests -- user-submitted feature requests
-- 6. subscriptions    -- billing plan info (free/pro)
-- 7. usage            -- reserved for future detailed usage tracking
--
-- Also includes:
-- - A trigger to auto-create a free subscription for new users
-- - RLS policies so users can only access their own data

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ============================================================================
-- TABLES
-- ============================================================================

-- 1. user_settings
create table user_settings (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_number text unique,
  imap_host text,
  imap_port integer default 993,
  imap_user text,
  imap_password_secret_id uuid,
  smtp_host text,
  smtp_port integer default 587,
  smtp_user text,
  smtp_password_secret_id uuid,
  voice_preference text default 'ash',
  tool_approval_config jsonb default '{}'::jsonb,
  pin_hash text,
  pin_attempts integer default 0,
  pin_locked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint user_settings_user_id_unique unique (user_id)
);

-- 2. user_memory
create table user_memory (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint user_memory_user_key_unique unique (user_id, key)
);

-- 3. sessions
create table sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_seconds integer,
  transcript jsonb default '[]'::jsonb,
  tokens_in integer default 0,
  tokens_out integer default 0,
  cost_usd numeric(10, 4) default 0,
  created_at timestamptz default now()
);

-- 4. actions
create table actions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  tool_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'executed', 'undone', 'rejected')),
  requires_approval boolean not null default false,
  undo_recipe jsonb,
  undo_deadline timestamptz,
  created_at timestamptz default now(),
  executed_at timestamptz
);

-- 5. feature_requests
create table feature_requests (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  description text not null,
  source text not null default 'dashboard'
    check (source in ('voice', 'dashboard')),
  created_at timestamptz default now()
);

-- 6. subscriptions
create table subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free'
    check (plan in ('free', 'pro')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint subscriptions_user_id_unique unique (user_id)
);

-- 7. usage (reserved for future detailed tracking)
create table usage (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  total_seconds integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create index idx_user_settings_phone on user_settings(phone_number);
create index idx_user_settings_user_id on user_settings(user_id);
create index idx_user_memory_user_id on user_memory(user_id);
create index idx_sessions_user_id on sessions(user_id);
create index idx_sessions_started_at on sessions(started_at);
create index idx_actions_user_id on actions(user_id);
create index idx_actions_session_id on actions(session_id);
create index idx_actions_status on actions(status);
create index idx_feature_requests_user_id on feature_requests(user_id);
create index idx_subscriptions_user_id on subscriptions(user_id);

-- ============================================================================
-- AUTO-CREATE FREE SUBSCRIPTION FOR NEW USERS
-- ============================================================================

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into subscriptions (user_id, plan)
  values (new.id, 'free');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_user();

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger user_settings_updated_at
  before update on user_settings
  for each row
  execute function update_updated_at();

create trigger user_memory_updated_at
  before update on user_memory
  for each row
  execute function update_updated_at();

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row
  execute function update_updated_at();

create trigger usage_updated_at
  before update on usage
  for each row
  execute function update_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table user_settings enable row level security;
alter table user_memory enable row level security;
alter table sessions enable row level security;
alter table actions enable row level security;
alter table feature_requests enable row level security;
alter table subscriptions enable row level security;
alter table usage enable row level security;

-- user_settings: users can only read/write their own settings
create policy "Users can view their own settings"
  on user_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert their own settings"
  on user_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own settings"
  on user_settings for update
  using (auth.uid() = user_id);

-- user_memory: users can only read/write their own memory
create policy "Users can view their own memory"
  on user_memory for select
  using (auth.uid() = user_id);

create policy "Users can insert their own memory"
  on user_memory for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own memory"
  on user_memory for update
  using (auth.uid() = user_id);

create policy "Users can delete their own memory"
  on user_memory for delete
  using (auth.uid() = user_id);

-- sessions: users can only view their own sessions
create policy "Users can view their own sessions"
  on sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own sessions"
  on sessions for insert
  with check (auth.uid() = user_id);

-- actions: users can only view/manage their own actions
create policy "Users can view their own actions"
  on actions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own actions"
  on actions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own actions"
  on actions for update
  using (auth.uid() = user_id);

-- feature_requests: users can only view/manage their own requests
create policy "Users can view their own feature requests"
  on feature_requests for select
  using (auth.uid() = user_id);

create policy "Users can insert their own feature requests"
  on feature_requests for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own feature requests"
  on feature_requests for delete
  using (auth.uid() = user_id);

-- subscriptions: users can only view their own subscription
create policy "Users can view their own subscription"
  on subscriptions for select
  using (auth.uid() = user_id);

-- usage: users can only view their own usage
create policy "Users can view their own usage"
  on usage for select
  using (auth.uid() = user_id);
