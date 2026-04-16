# How to Read Supabase Safely

This document is for read-only database access.

## Non-negotiable rule

IT SHOULD NEVER MAKE CHANGES.

That means:

- Only use `GET` requests against the Supabase REST or Auth admin APIs.
- Never use `POST`, `PATCH`, `PUT`, or `DELETE`.
- Never run `supabase db push`, migrations, SQL editors, or write scripts from this workflow.
- Never use the service role key for anything except read-only requests.

The service role key can bypass RLS and write to production data. Treat it as read-only by policy.

## Required environment variables

Do not read `apps/web/.env` directly from the instructions in this file.

Instead, require these variables to already be available in the shell:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Then normalize them into the variables used by the commands below:

```bash
export SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL is not set}"
export SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is not set}"
```

Optional:

```bash
command -v jq >/dev/null || echo "jq not installed; raw JSON output will be used"
```

## Standard headers

All read-only requests should use these headers:

```bash
-H "apikey: $SUPABASE_KEY"
-H "Authorization: Bearer $SUPABASE_KEY"
```

## Safe request pattern

Use `curl -sS -G` with query parameters passed via `--data-urlencode`.

```bash
curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "select=*" \
  --data-urlencode "limit=5" \
  "$SUPABASE_URL/rest/v1/user_settings"
```

This stays read-only because it is a `GET` request.

## Common read-only queries

### List a few rows from a table

```bash
TABLE="your_table"

curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "select=*" \
  --data-urlencode "limit=10" \
  "$SUPABASE_URL/rest/v1/$TABLE"
```

### Filter rows by one column

```bash
TABLE="your_table"
COLUMN="id"
VALUE="replace-me"

curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "select=*" \
  --data-urlencode "$COLUMN=eq.$VALUE" \
  "$SUPABASE_URL/rest/v1/$TABLE"
```

### Order rows and limit results

```bash
TABLE="your_table"
ORDER_COLUMN="created_at"

curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "select=*" \
  --data-urlencode "order=$ORDER_COLUMN.desc" \
  --data-urlencode "limit=5" \
  "$SUPABASE_URL/rest/v1/$TABLE"
```

### Select only specific columns

```bash
TABLE="your_table"
SELECT_COLUMNS="id,created_at,status"

curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "select=$SELECT_COLUMNS" \
  --data-urlencode "limit=20" \
  "$SUPABASE_URL/rest/v1/$TABLE"
```

### Read from the Auth admin API

This is useful when the information lives in Supabase Auth rather than a PostgREST table.

```bash
curl -sS -G \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  --data-urlencode "page=1" \
  --data-urlencode "per_page=200" \
  "$SUPABASE_URL/auth/v1/admin/users"
```

If needed, filter the returned JSON locally with `jq`.

## What not to do

- Do not read `.env` files directly from this workflow.
- Do not use any command that writes to the database.
- Do not run migrations.
- Do not create, update, or delete auth users.
- Do not change storage objects or buckets.

If a task requires any mutation, stop and ask for a different workflow. This document is only for safe reads.
