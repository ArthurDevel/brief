-- Migrate voice_preference (text) to voice_config (jsonb)
-- Preserves existing voice selections with default speed of 1.0

ALTER TABLE user_settings
  ADD COLUMN voice_config jsonb DEFAULT '{"voice": "aura-2-helena-en", "speed": 1.0}'::jsonb;

UPDATE user_settings
  SET voice_config = jsonb_build_object('voice', voice_preference, 'speed', 1.0)
  WHERE voice_preference IS NOT NULL;

ALTER TABLE user_settings
  DROP COLUMN voice_preference;
