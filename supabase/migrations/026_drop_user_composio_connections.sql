-- Drops the unused Composio connection cache table now that the app reads
-- connector state directly from Composio.

drop table if exists user_composio_connections;
