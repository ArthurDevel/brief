-- Persist execution-agent conversations by user and agent name.
--
-- Changes:
-- - adds execution_agent_threads for one thread per user + agent name
-- - adds execution_agent_messages for append-only execution history
-- - stores assistant tool calls and tool results as queryable jsonb

create extension if not exists pgcrypto;

create table if not exists execution_agent_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint execution_agent_threads_user_agent_unique unique (user_id, agent_name),
  constraint execution_agent_threads_id_user_unique unique (id, user_id)
);

create index if not exists idx_execution_agent_threads_user_id
  on execution_agent_threads(user_id);
create index if not exists idx_execution_agent_threads_user_agent
  on execution_agent_threads(user_id, agent_name);

drop trigger if exists execution_agent_threads_updated_at on execution_agent_threads;
create trigger execution_agent_threads_updated_at
  before update on execution_agent_threads
  for each row
  execute function update_updated_at();

alter table execution_agent_threads enable row level security;

drop policy if exists "Users can view their own execution agent threads" on execution_agent_threads;
create policy "Users can view their own execution agent threads"
  on execution_agent_threads for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own execution agent threads" on execution_agent_threads;
create policy "Users can insert their own execution agent threads"
  on execution_agent_threads for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own execution agent threads" on execution_agent_threads;
create policy "Users can update their own execution agent threads"
  on execution_agent_threads for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own execution agent threads" on execution_agent_threads;
create policy "Users can delete their own execution agent threads"
  on execution_agent_threads for delete
  using (auth.uid() = user_id);

create table if not exists execution_agent_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null
    check (role in ('assistant', 'tool', 'user')),
  content text not null default '',
  tool_call_id text,
  tool_name text,
  tool_arguments jsonb,
  tool_calls jsonb,
  tool_result jsonb,
  created_at timestamptz not null default now(),
  constraint execution_agent_messages_thread_user_fk
    foreign key (thread_id, user_id)
    references execution_agent_threads(id, user_id)
    on delete cascade
);

create index if not exists idx_execution_agent_messages_user_id
  on execution_agent_messages(user_id);
create index if not exists idx_execution_agent_messages_thread_created_at
  on execution_agent_messages(thread_id, created_at);
create index if not exists idx_execution_agent_messages_user_thread_created_at
  on execution_agent_messages(user_id, thread_id, created_at);

alter table execution_agent_messages enable row level security;

drop policy if exists "Users can view their own execution agent messages" on execution_agent_messages;
create policy "Users can view their own execution agent messages"
  on execution_agent_messages for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own execution agent messages" on execution_agent_messages;
create policy "Users can insert their own execution agent messages"
  on execution_agent_messages for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own execution agent messages" on execution_agent_messages;
create policy "Users can delete their own execution agent messages"
  on execution_agent_messages for delete
  using (auth.uid() = user_id);
