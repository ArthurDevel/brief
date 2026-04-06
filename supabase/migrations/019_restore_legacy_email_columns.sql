-- Restores the legacy email columns on user_settings that were prematurely
-- dropped by 018. These columns must remain until all code paths are verified
-- working against user_email_accounts.

alter table user_settings add column if not exists imap_host text;
alter table user_settings add column if not exists imap_port integer default 993;
alter table user_settings add column if not exists imap_user text;
alter table user_settings add column if not exists imap_password_secret_id uuid;
alter table user_settings add column if not exists smtp_host text;
alter table user_settings add column if not exists smtp_port integer default 587;
alter table user_settings add column if not exists smtp_user text;
alter table user_settings add column if not exists smtp_password_secret_id uuid;
alter table user_settings add column if not exists contacts_synced_at timestamptz;

-- Backfill from user_email_accounts so existing custom users keep their data
-- in the legacy columns during the transition period.
update user_settings us
set
  imap_host = uea.imap_host,
  imap_port = uea.imap_port,
  imap_user = uea.imap_user,
  imap_password_secret_id = uea.imap_password_secret_id,
  smtp_host = uea.smtp_host,
  smtp_port = uea.smtp_port,
  smtp_user = uea.smtp_user,
  smtp_password_secret_id = uea.smtp_password_secret_id
from user_email_accounts uea
where uea.user_id = us.user_id
  and uea.is_active = true
  and uea.connection_type = 'imap_smtp';
