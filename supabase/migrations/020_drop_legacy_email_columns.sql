-- Drops the legacy IMAP/SMTP columns from user_settings now that all code
-- paths read from user_email_accounts. This replaces the earlier 018 attempt
-- which was rolled back by 019.

alter table user_settings drop column if exists imap_host;
alter table user_settings drop column if exists imap_port;
alter table user_settings drop column if exists imap_user;
alter table user_settings drop column if exists imap_password_secret_id;
alter table user_settings drop column if exists smtp_host;
alter table user_settings drop column if exists smtp_port;
alter table user_settings drop column if exists smtp_user;
alter table user_settings drop column if exists smtp_password_secret_id;
alter table user_settings drop column if exists contacts_synced_at;
