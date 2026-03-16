"""
Tool system for the voice pipeline.

Provides tool definitions, classification logic, email operations,
and action dispatch/queue management.

- definitions: 10 tool schemas in OpenAI function-calling format
- classification: action classification with user overrides
- email_client: IMAP + SMTP operations with reconnect
- handlers: tool dispatch, action queue DB writes, undo recipes
- vault: Supabase Vault RPC wrappers
"""
