# Envelope Date Investigation

## Goal

Determine why `list_inbox` with `since="2026-04-03T08:47:57-07:00"` returned 0 results in production, despite emails existing at 9:00 AM and 9:15 AM PDT.

## What we found

**Gmail's IMAP returns all envelope dates as NAIVE datetimes (no timezone info).** Every single one of the 100+ emails tested had `tzinfo: NAIVE`.

The naive dates represent the **sender's local time**, not UTC. For example, the AlphaSignal email at `09:15:24` matches the time shown in the conversation log where it appeared as 9:15 AM PDT.

## Root cause

In `_filter_uids_by_datetime`, we assumed naive envelope dates were UTC:

```python
if env_date.tzinfo is None:
    env_date = env_date.replace(tzinfo=timezone.utc)  # WRONG: not UTC
```

When `since` had a `-07:00` offset (PDT), the comparison became:
- Envelope: `9:15` treated as `9:15 UTC`
- Since: `8:47 PDT` = `15:47 UTC`
- `9:15 UTC < 15:47 UTC` = filtered out

## Fix

Strip timezone from `since` and compare both as naive local times:

```python
since_naive = since.replace(tzinfo=None)
# ...
env_date = envelope.date
if env_date.tzinfo is not None:
    env_date = env_date.replace(tzinfo=None)
if env_date > since_naive:
    filtered.append(uid)
```

This works because the LLM's `since` datetime is in the user's local timezone (set via session context), and Gmail's naive envelope dates are also in local time.

## Results

- **Before fix:** 0 of 100 emails passed the filter (all incorrectly rejected)
- **After fix:** 7 of 101 emails passed (the correct ones after 8:47 AM on April 3rd)

The 7 passing emails match exactly what the conversation showed: Google Ads (9:00), SkinVision (9:00), AlphaSignal (9:15), Realtor (10:04), and GitHub notifications.

## How to run

```bash
cd apps/voice-pipeline
uv run python ../../testscripts/2026.04.03-envelope-date-investigation/investigate.py
```

Requires IMAP credentials -- falls back to Supabase Vault if local `.env` has no `IMAP_PASSWORD`.
