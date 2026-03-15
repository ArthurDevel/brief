-- Add plaintext password columns for MVP.
-- Vault integration (imap_password_secret_id / smtp_password_secret_id) can replace these later.

alter table user_settings add column if not exists imap_password text;
alter table user_settings add column if not exists smtp_password text;
