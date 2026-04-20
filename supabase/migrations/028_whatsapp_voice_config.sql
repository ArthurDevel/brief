-- Add WhatsApp-specific voice settings to user_settings.
--
-- Changes:
-- - adds a dedicated whatsapp_voice_config JSONB column
-- - keeps WhatsApp voice settings separate from the main product voice settings

alter table user_settings
  add column if not exists whatsapp_voice_config jsonb
  default '{"provider": "deepgram", "voiceId": "aura-2-andromeda-en", "speed": 1.2}'::jsonb;
