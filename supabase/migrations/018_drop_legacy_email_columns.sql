-- Run ONLY after all code paths switched to user_email_accounts.
--
-- Removes the legacy IMAP/SMTP columns and contacts_synced_at from
-- user_settings now that all readers use user_email_accounts instead.

alter table user_settings drop column if exists imap_host;
alter table user_settings drop column if exists imap_port;
alter table user_settings drop column if exists imap_user;
alter table user_settings drop column if exists imap_password_secret_id;
alter table user_settings drop column if exists smtp_host;
alter table user_settings drop column if exists smtp_port;
alter table user_settings drop column if exists smtp_user;
alter table user_settings drop column if exists smtp_password_secret_id;
alter table user_settings drop column if exists contacts_synced_at;
