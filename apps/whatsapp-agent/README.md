# WhatsApp Agent

Minimal TypeScript LiveKit agent for the WhatsApp calling MVP.

## What it does

- Joins LiveKit rooms as a voice agent
- Resolves the caller phone from the WhatsApp LiveKit bridge metadata
- Loads the caller's connected Composio accounts from Supabase
- Exposes the caller's connected Composio tools directly to the LLM
- Speaks concise responses suitable for phone calls

## Local run

```bash
cd apps/whatsapp-agent
cp .env.example .env.local
pnpm install
pnpm dev
```

## LiveKit Cloud deployment

1. Install the LiveKit CLI.
2. Authenticate the CLI with your LiveKit Cloud project.
3. Create the deployment from this directory:

```bash
lk agent create apps/whatsapp-agent
```

4. Upload secrets such as `COMPOSIO_API_KEY`:

```bash
lk agent update-secrets --working-dir apps/whatsapp-agent --secrets-file apps/whatsapp-agent/.env.local
```

5. Deploy updates:

```bash
lk agent deploy apps/whatsapp-agent
```

This repo does not currently include a generated deployment ID because LiveKit credentials were not present during implementation.
