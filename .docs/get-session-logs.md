# How to Get Session Logs

Quick reference for debugging voice pipeline sessions using Supabase, the production server, and Vercel.

## Prerequisites

Get credentials from `apps/voice-pipeline/.env`:
- `SUPABASE_URL` (e.g. `https://tichpsefrxezwosobmzk.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` (JWT token)

All requests need these headers:
```
-H "apikey: $KEY"
-H "Authorization: Bearer $KEY"
```

## 1. List Recent Sessions

```bash
curl -s "$SUPABASE_URL/rest/v1/sessions?select=id,user_id,started_at,ended_at,duration_seconds&order=started_at.desc&limit=5" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY"
```

## 2. Get Actions for a Session

```bash
curl -s "$SUPABASE_URL/rest/v1/actions?select=id,tool_name,status,requires_approval,created_at&session_id=eq.$SESSION_ID&order=created_at.asc" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY"
```

## 3. Get Transcript for a Session

```bash
curl -s "$SUPABASE_URL/rest/v1/sessions?select=id,transcript&id=eq.$SESSION_ID" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY"
```

## 4. Download Session Log File

Session logs are stored in Supabase Storage bucket `session-logs` as `{session_id}.log`.

```bash
curl -s "$SUPABASE_URL/storage/v1/object/session-logs/$SESSION_ID.log" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY"
```

Useful tail/grep combos:
```bash
# Last 20 lines (end-of-session hook result, costs, etc.)
... | tail -20

# Search for errors or hook failures
... | grep -i "error\|warning\|hook\|end-of-session"
```

## What to Look For

- **End-of-session hook failure**: `End-of-session hook failed for session ... : All connection attempts failed` -- means the voice pipeline couldn't reach the web app (`WEB_APP_URL` in `.env`).
- **No email sent (read-only actions only)**: The endpoint filters out read-only actions (`list_inbox`, `read_email`, `read_thread`, `search_emails`, `list_folders`, `save_memory`, `submit_feature_request`, `find_contact`). If all actions are read-only, no summary email is sent.
- **No actions at all**: If the session has zero actions, the endpoint returns `{ emailSent: false }` immediately.
- **IMAP enrichment errors**: Logged as `Enrichment failed, continuing` -- non-fatal, email still sends.

## 5. Access the Production Server

### Infrastructure overview

- **Hetzner server** (`65.109.15.3`): Runs Coolify, which manages Docker containers for the voice pipeline, Langfuse, Qdrant, PostgreSQL, and other services.
- **Coolify**: Self-hosted PaaS on the Hetzner server. Manages deployments, env vars, and Docker containers. The voice pipeline is deployed here as a Docker container.
- **Vercel**: Hosts the Next.js web app (`apps/web`). Not on the Hetzner server.
- **Supabase**: Managed cloud database and storage. Not on the Hetzner server.

### Key URLs

| URL | What it is |
|-----|-----------|
| `https://app.brewdock.ai` | Production web app (Next.js on Vercel) -- this is the correct `WEB_APP_URL` |
| `https://brief-web-kappa.vercel.app` | Same web app, direct Vercel URL |
| `https://brewdock.ai` | Landing page only -- does NOT have API routes |

### SSH access

```bash
ssh -i ~/.ssh/hetznercoolify root@65.109.15.3
```

### Finding and inspecting the voice pipeline container

```bash
# List all running containers
docker ps --format '{{.Names}} {{.Image}}'

# The voice pipeline container name is a Coolify-generated hash
# Identify it by the image tag (matches a git commit SHA from this repo)

# Check env vars
docker exec <CONTAINER_NAME> env | grep -E 'WEB_APP_URL|INTERNAL_API_KEY|SUPABASE'

# View live container logs
docker logs <CONTAINER_NAME> --tail 100 -f
```

## 6. Vercel Logs (Web App)

The Next.js web app runs on Vercel. Use the Vercel CLI to query server-side function logs (e.g. end-of-session endpoint responses, errors).

### Setup

The CLI must be linked to the correct project/team. If not already set up:

```bash
vercel login              # OAuth device flow -- opens browser
vercel switch 0x41        # switch to the 0x41 team
cd apps/web && vercel link --yes --project brief-web
```

### Querying logs

Always pass `--project brief-web --scope 0x41` to avoid needing to be in the linked directory.

```bash
# All end-of-session requests in the last 24h
vercel logs --environment production --since 24h --json --no-follow --no-branch \
  --project brief-web --scope 0x41 --limit 500 \
  | grep "end-of-session"

# Filter by status code (e.g. errors only)
vercel logs --environment production --since 24h --status-code 500 \
  --project brief-web --scope 0x41 --no-follow --no-branch --expand

# Search for specific text in log messages
vercel logs --environment production --since 24h --query "IMAP" \
  --project brief-web --scope 0x41 --no-follow --no-branch --expand

# Stream live logs
vercel logs --environment production --follow \
  --project brief-web --scope 0x41
```

### Useful flags

| Flag | Purpose |
|------|---------|
| `--since 24h` | Time range (also accepts ISO dates) |
| `--until 2h` | End of time range |
| `--level error` | Filter by level: error, warning, info, fatal |
| `--status-code 500` | Filter by HTTP status (also `4xx`, `5xx`) |
| `--query "text"` | Full-text search |
| `--expand` | Show full log message below each request line |
| `--json` | JSON output, useful for piping to `jq` or `python3` |
| `--no-follow` | Historical logs (default streams live) |

### Note on log retention

Vercel log retention depends on your plan. If a request never reached Vercel (e.g. DNS/network failure on the caller side), there will be no Vercel log entry for it.

## Key Tables

| Table | What it stores |
|-------|---------------|
| `sessions` | Call records (id, user_id, started_at, ended_at, duration_seconds, transcript, tokens, cost) |
| `actions` | Tool calls per session (tool_name, arguments, status, requires_approval) |
| `user_settings` | IMAP/SMTP config, call schedule, tool approval config |

## Key Storage Buckets

| Bucket | Contents |
|--------|----------|
| `session-logs` | Pipeline log files (`{session_id}.log`) |
| `call-recordings` | Audio recordings from calls |

## Key Files

- `apps/voice-pipeline/src/server.py` -- `_cleanup_session()` triggers the hook, `_trigger_end_of_session_hook()` makes the HTTP call
- `apps/web/app/api/sessions/[id]/end-of-session/route.ts` -- processes actions, sends email via Resend
- `apps/voice-pipeline/src/session_logger.py` -- captures and uploads `.log` files to Supabase Storage
