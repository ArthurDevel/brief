# Langfuse CLI

## Auth

Keys are in `apps/voice-pipeline/.env` (symlinked from the main repo). The host is `https://us.cloud.langfuse.com`.

```bash
langfuse --env apps/voice-pipeline/.env api <resource> <action>
```

## Skill

Run `langfuse get-skill` to print the full CLI reference with common commands and discovery.
