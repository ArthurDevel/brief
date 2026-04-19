-- Replace the old WhatsApp test-thread storage with the WhatsApp auth identity.
--
-- Changes:
-- - drops the legacy whatsapp_messages table used by the old admin test console
-- - adds a dedicated whatsapp_phone column to user_settings
-- - enforces uniqueness for whatsapp_phone without touching user_settings.phone

drop table if exists whatsapp_messages cascade;

alter table user_settings
  add column if not exists whatsapp_phone text;

create unique index if not exists idx_user_settings_whatsapp_phone
  on user_settings (whatsapp_phone)
  where whatsapp_phone is not null;
