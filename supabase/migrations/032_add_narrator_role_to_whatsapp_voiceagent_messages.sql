-- Allow spoken narrator messages in WhatsApp voice interaction history.
--
-- Changes:
-- - adds narrator as a valid role in whatsapp_voiceagent_messages

alter table whatsapp_voiceagent_messages
  drop constraint if exists whatsapp_voiceagent_messages_role_check;

alter table whatsapp_voiceagent_messages
  add constraint whatsapp_voiceagent_messages_role_check
  check (role in ('user', 'assistant', 'narrator', 'tool'));
