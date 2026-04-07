# Unipile API Exploration

## Goal

Verify the actual Unipile REST API behavior against our implementation assumptions in `packages/email/src/unipile-client.ts`, `apps/voice-pipeline/src/tools/unipile_client.py`, and `apps/web/lib/unipile/client.ts`.

## How to run

```bash
cp .env.example .env
# Fill in UNIPILE_DSN and UNIPILE_API_KEY
node explore.mjs   # Round 1: basic endpoint probing
node explore2.mjs  # Round 2: corrected formats, mutations
node explore3.mjs  # Round 3: reply, move, filter params
```

## Findings

### Authentication

| Header | Result |
|--------|--------|
| `X-API-KEY: {key}` | 200 - works |
| `Authorization: Bearer {key}` | 401 - does NOT work |
| `Access-Token: {key}` | 401 - does NOT work |

**Fix needed:** `packages/email/src/unipile-client.ts` uses `Authorization: Bearer`. Must use `X-API-KEY`.

### Email Object Shape

Fields are NOT `from` / `to` / `cc`. The actual shape is:

```json
{
  "from_attendee": {
    "display_name": "Sender Name",
    "identifier": "sender@example.com",
    "identifier_type": "EMAIL_ADDRESS"
  },
  "to_attendees": [
    { "display_name": "...", "identifier": "...", "identifier_type": "EMAIL_ADDRESS" }
  ],
  "cc_attendees": [],
  "bcc_attendees": [],
  "reply_to_attendees": [],
  "subject": "...",
  "body": "<html>...</html>",
  "body_plain": "plain text version",
  "date": "2026-04-06T18:23:50.000Z",
  "id": "Hg49Cbw9Xzi9UY6Swtvsfw",
  "provider_id": "19d640969599fcb9",
  "message_id": "<rfc822-message-id@domain>",
  "thread_id": "19d640969599fcb9",
  "folders": ["CATEGORY_UPDATES", "UNREAD", "INBOX"],
  "folderIds": ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
  "role": "all",
  "read_date": "2026-04-06T..." | null,
  "has_attachments": false,
  "attachments": [],
  "is_complete": true,
  "origin": "external"
}
```

**Fix needed:** All field mappings in both TS and Python unipile clients.

### Endpoints That Exist

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /api/v1/accounts` | 200 | Works, returns `{ items: [...] }` |
| `GET /api/v1/accounts/{id}` | 200 | Email is at `connection_params.mail.id` |
| `GET /api/v1/emails?account_id=X&limit=N` | 200 | Works |
| `GET /api/v1/emails?account_id=X&q=query` | 200 | Search works |
| `GET /api/v1/emails?account_id=X&from=addr` | 200 | Filter by sender works |
| `GET /api/v1/emails?account_id=X&after=ISO` | 200 | Date filter works |
| `GET /api/v1/emails?account_id=X&thread_id=X` | 200 | Thread listing via query param |
| `GET /api/v1/emails/{id}` | 200 | Full email detail |
| `POST /api/v1/emails` | 201 | Send email (also supports `reply_to` and `draft: true`) |
| `PUT /api/v1/emails/{id}` | 200 | Update (mark read: `{ unread: false }`, move: `{ folders: ["LABEL"] }`) |
| `DELETE /api/v1/emails/{id}` | 200 | Move to trash |
| `GET /api/v1/folders?account_id=X` | 200 | Folder listing |
| `POST /api/v1/hosted/accounts/link` | 201 | Hosted auth link creation |

### Endpoints That Do NOT Exist

| Assumed endpoint | Status | Alternative |
|------------------|--------|-------------|
| `GET /api/v1/emails/{id}/thread` | 404 | Use `GET /api/v1/emails?thread_id=X` |
| `POST /api/v1/emails/{id}/reply` | 404 | Use `POST /api/v1/emails` with `reply_to: provider_id` |
| `POST /api/v1/emails/drafts` | 404 | Use `POST /api/v1/emails` with `draft: true` |
| `GET /api/v1/emails/contacts` | 401 | Requires Google People API scopes (not enabled) |

### Reply Mechanism

Replies go through `POST /api/v1/emails` with:
- `reply_to`: must be the **provider_id** (e.g. `"19d640969599fcb9"`), NOT the Unipile email ID
- `subject`: must start with `Re: ` (validated server-side)
- `to`: array of `{ display_name, identifier }` objects

Using the Unipile email ID as `reply_to` returns `422 parent_mail_not_found`.

### Draft Creation

Drafts go through `POST /api/v1/emails` with `draft: true` flag. No separate endpoint.

### Move / Archive / Label

`PUT /api/v1/emails/{id}` with:
- `{ folders: ["LABEL_NAME"] }` -- array of strings (folder names/labels)
- `{ unread: false }` -- mark as read

The `folders` field is an **array of strings**, NOT `{ destination, source }`.

Note: Some emails returned by list may 404 on PUT (possibly not fully synced). The `is_complete` field indicates sync status.

### Folder Object Shape

```json
{
  "id": "x1YZ_ieLUcqO9XWxSpz2Cw",
  "name": "INBOX",
  "account_id": "...",
  "role": "inbox",        // NOT "folder_type" -- docs were wrong, role is correct
  "status": "UNSYNC",
  "nb_mails": 7198,
  "provider_id": "INBOX"
}
```

Known roles: `inbox`, `sent`, `drafts`, `trash`, `spam`, `starred`, `important`, `unknown`.

### Hosted Auth Format

Required body for `POST /api/v1/hosted/accounts/link`:
```json
{
  "type": "create",
  "providers": ["GOOGLE"],          // Array, NOT singular "provider"
  "api_url": "https://api36.unipile.com:16636",
  "expiresOn": "2026-12-31T23:59:59.000Z",  // camelCase, must match pattern with .000Z
  "name": "correlation_token",
  "notify_url": "https://your-app.com/callback"
}
```

For reconnect:
```json
{
  "type": "reconnect",
  "reconnect_account": "account_id_here",
  "api_url": "...",
  "expiresOn": "..."
}
```

**Fix needed:** Our code sends `provider` (singular string) and `expires_on` (snake_case).

### Account Object Shape

```json
{
  "id": "WsiwfGOgQiy_sS1te2G97Q",
  "name": "arthur.stockman.me@gmail.com",
  "type": "GOOGLE_OAUTH",
  "connection_params": {
    "mail": { "id": "email@example.com", "username": "email@example.com" }
  },
  "sources": [{ "id": "..._MAILS", "status": "OK" }]
}
```

Email address is at `connection_params.mail.id` (or fallback to `name` field).
Status is at `sources[0].status` (not top-level).

### Send Email Format

```json
{
  "account_id": "...",
  "subject": "Subject",
  "body": "HTML or plain text body",
  "to": [{ "display_name": "Name", "identifier": "email@example.com" }],
  "cc": [],
  "bcc": [],
  "reply_to": "provider_id_of_parent",  // for replies
  "draft": true                          // for drafts
}
```

## Summary of Required Fixes

1. **Auth header**: `X-API-KEY` everywhere (TS unipile-client uses wrong `Authorization: Bearer`)
2. **Email field mapping**: `from_attendee.identifier` not `from`, `to_attendees[].identifier` not `to`
3. **Reply**: `POST /api/v1/emails` with `reply_to: provider_id` (not a separate endpoint)
4. **Thread**: `GET /api/v1/emails?thread_id=X` (not `/emails/{id}/thread`)
5. **Draft**: `POST /api/v1/emails` with `draft: true` (not `/emails/drafts`)
6. **Move/archive**: `PUT` with `{ folders: ["LABEL"] }` as string array
7. **Mark read**: `PUT` with `{ unread: false }`
8. **Hosted auth**: `providers` (array) + `expiresOn` (camelCase with .000Z)
9. **Account email**: `connection_params.mail.id` not `email`
10. **Account status**: `sources[].status` not top-level `status`
11. **Send format**: `to` is array of `{ display_name, identifier }` objects
12. **Folder role**: field IS called `role` (not `folder_type` as docs suggested)
