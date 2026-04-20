# WhatsApp Notion Debug

Goal: verify whether the WhatsApp agent can actually see Notion tools for a specific user, and if yes, understand why a vague prompt like "can you check notion" might still fail.

What I tested:
- Loaded the user's live Composio connected accounts
- Reproduced the WhatsApp agent's "pick the latest ACTIVE account per toolkit" logic
- Loaded the raw Notion tool inventory from Composio

What I found:
- The target user has an ACTIVE Notion connected account
- The WhatsApp agent selection logic keeps that active Notion account
- Composio returns a large Notion tool inventory for that user

What likely explains the bad answer:
- The model was not missing the Notion connection
- The request "can you check notion" is too vague
- The prompt does not tell the model "you definitely have Notion connected"
- The tool inventory is action-specific, not a single generic "check notion" tool

How to run:

```bash
cp testscripts/2026.04.20-whatsapp-notion-debug/.env.example testscripts/2026.04.20-whatsapp-notion-debug/.env
pnpm --filter @dublin/whatsapp-agent exec node testscripts/2026.04.20-whatsapp-notion-debug/inspectNotionTools.mjs 331a94ad-e53b-45eb-b836-b4951c8e2548
```

Expected outcome:
- The script should show `notion` in `connectedAccountsByToolkit`
- The script should show many `NOTION_*` tool slugs
