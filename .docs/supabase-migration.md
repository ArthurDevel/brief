# Supabase Migrations

## Prerequisites

- Supabase CLI installed (`npx supabase` or globally)
- Project linked: `npx supabase link --project-ref tichpsefrxezwosobmzk`

The project ref comes from the Supabase URL in `apps/web/.env` (`NEXT_PUBLIC_SUPABASE_URL`).

## Creating a new migration

```bash
npx supabase migration new <name>
```

This creates a new file in `supabase/migrations/` with a timestamp prefix. We use a simpler naming convention with sequential numbers (e.g. `013_action_converted_status.sql`), so rename the generated file accordingly.

## Writing the migration

Write raw SQL in the migration file. Keep it minimal -- one concern per file.

Example (`013_action_converted_status.sql`):
```sql
-- Add "converted" to the allowed action statuses.
alter table actions drop constraint actions_status_check;
alter table actions add constraint actions_status_check
  check (status in ('pending', 'approved', 'executed', 'undone', 'rejected', 'failed', 'converted'));
```

## Pushing to remote

```bash
npx supabase db push
```

This applies any unapplied migrations to the remote database. Already-applied migrations are tracked and skipped.

## Notes

- There is no local Supabase setup (no Docker) -- migrations are pushed directly to the remote project.
- Migrations are not reversible by default. If you need to undo, write a new migration.
- The Supabase CLI checks `supabase/migrations/` for files and tracks which ones have been applied in a `supabase_migrations` schema table on the remote DB.
