-- Persist WhatsApp voice interaction-agent history per call session.
--
-- Changes:
-- - adds whatsapp_voiceagent_messages for one voice-call session history
-- - stores interaction-agent messages, tool calls, and tool results

create table if not exists whatsapp_voiceagent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null
    check (type in ('message', 'tool_call', 'tool_result')),
  role text not null
    check (role in ('user', 'assistant', 'tool')),
  text text not null default '',
  tool_name text,
  tool_call_id text,
  tool_arguments jsonb,
  tool_result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_voiceagent_messages_user_id
  on whatsapp_voiceagent_messages(user_id);
create index if not exists idx_whatsapp_voiceagent_messages_session_created_at
  on whatsapp_voiceagent_messages(session_id, created_at);
create index if not exists idx_whatsapp_voiceagent_messages_user_session_created_at
  on whatsapp_voiceagent_messages(user_id, session_id, created_at);

alter table whatsapp_voiceagent_messages enable row level security;

drop policy if exists "Users can view their own whatsapp voice agent messages" on whatsapp_voiceagent_messages;
create policy "Users can view their own whatsapp voice agent messages"
  on whatsapp_voiceagent_messages for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own whatsapp voice agent messages" on whatsapp_voiceagent_messages;
create policy "Users can insert their own whatsapp voice agent messages"
  on whatsapp_voiceagent_messages for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own whatsapp voice agent messages" on whatsapp_voiceagent_messages;
create policy "Users can delete their own whatsapp voice agent messages"
  on whatsapp_voiceagent_messages for delete
  using (auth.uid() = user_id);
