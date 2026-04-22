# WhatsApp Template Copy

## Goal

Copy WhatsApp message templates from one WhatsApp Business Account to another with the Meta Graph API.

## What this script does

- Reads templates from the source WABA
- Reads existing templates from the destination WABA
- Builds a copy plan
- Skips destination templates that already exist with the same name and language
- Creates missing templates when you run with `--apply`
- Writes the plan and results to `output/`

## Safety

- Dry-run is the default
- The script only creates templates when you pass `--apply`
- The script fails if the destination WABA already has duplicate template name and language pairs

## What it copies

- `name`
- `language`
- `category`
- `sub_category` when present
- `parameter_format` when present
- `components`
- `message_send_ttl_seconds` when present

## What it does not do

- It does not delete or update templates
- It does not bypass Meta review
- It does not rename templates automatically

Meta may still review recreated templates on the new WABA.

## Required env vars

Copy `.env.example` to `.env` and fill in:

- `WHATSAPP_API_VERSION`
- `WHATSAPP_SOURCE_WABA_ID`
- `WHATSAPP_SOURCE_ACCESS_TOKEN`
- `WHATSAPP_DESTINATION_WABA_ID`
- `WHATSAPP_DESTINATION_ACCESS_TOKEN`

If one token can access both WABAs, set the same value for both token vars.

## How to run

```bash
cd testscripts/2026.04.21-whatsapp-template-copy
pnpm run run
```

Dry-run only:

```bash
pnpm run run
```

Create templates:

```bash
pnpm run run -- --apply
```

Copy only specific templates:

```bash
pnpm run run -- --only-names=session_summary,voice_settings
```

Include more statuses:

```bash
pnpm run run -- --include-statuses=APPROVED,PAUSED
```

## Output

- `output/copy-plan.json`
- `output/copy-result.json`
