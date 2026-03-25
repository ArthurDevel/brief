-- Add "failed" to the allowed action statuses.
alter table actions drop constraint actions_status_check;
alter table actions add constraint actions_status_check
  check (status in ('pending', 'approved', 'executed', 'undone', 'rejected', 'failed'));
