-- Add raw LiveKit model usage to sessions so cost can be derived externally.

alter table sessions
add column model_usage jsonb default '[]'::jsonb;
