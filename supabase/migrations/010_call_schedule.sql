-- Add call_schedule JSONB column to user_settings for scheduled calling feature.

alter table user_settings
  add column call_schedule jsonb default null;
