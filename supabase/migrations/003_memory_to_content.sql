-- Migrate user_memory from key-value pairs to freeform markdown content.
--
-- Changes:
-- - Drop the unique constraint on (user_id, key)
-- - Drop the `key` column
-- - Rename `value` to `content`

alter table user_memory drop constraint user_memory_user_key_unique;
alter table user_memory drop column key;
alter table user_memory rename column value to content;
