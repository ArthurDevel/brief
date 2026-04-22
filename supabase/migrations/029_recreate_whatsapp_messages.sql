-- Recreate WhatsApp message storage for the WhatsApp text agent.
--
-- Changes:
-- - recreates whatsapp_messages after the old test-console table was dropped
-- - restores indexes, trigger, and RLS policies needed by the current WhatsApp flows

create extension if not exists pgcrypto;

create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  contact_phone_number text not null,
  direction text not null
    check (direction in ('inbound', 'outbound')),
  text text not null default '',
  meta_message_id text unique,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'delivered', 'read', 'received', 'failed')),
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_messages_user_id on whatsapp_messages(user_id);
create index if not exists idx_whatsapp_messages_contact_created_at
  on whatsapp_messages(contact_phone_number, created_at);
create index if not exists idx_whatsapp_messages_user_contact_created_at
  on whatsapp_messages(user_id, contact_phone_number, created_at);

drop trigger if exists whatsapp_messages_updated_at on whatsapp_messages;
create trigger whatsapp_messages_updated_at
  before update on whatsapp_messages
  for each row
  execute function update_updated_at();

alter table whatsapp_messages enable row level security;

drop policy if exists "Users can view their own whatsapp messages" on whatsapp_messages;
create policy "Users can view their own whatsapp messages"
  on whatsapp_messages for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own whatsapp messages" on whatsapp_messages;
create policy "Users can insert their own whatsapp messages"
  on whatsapp_messages for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own whatsapp messages" on whatsapp_messages;
create policy "Users can update their own whatsapp messages"
  on whatsapp_messages for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own whatsapp messages" on whatsapp_messages;
create policy "Users can delete their own whatsapp messages"
  on whatsapp_messages for delete
  using (auth.uid() = user_id);
