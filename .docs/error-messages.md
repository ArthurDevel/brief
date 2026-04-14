# Error Messages

## Front-End Error Messages

The dashboard should never show raw technical errors from providers, databases, or internal APIs.

The system we follow is:

- Show a defined, human-readable message when we recognize the error.
- Fall back to `Something went wrong. Please try again.` when we do not.
- Log the original technical error to the console for debugging.
- Prefer stable API error `code` values over parsing raw backend text.

This keeps the UI understandable for users while preserving enough detail for debugging in client and server logs.

## Shared Front-End Modules

When working on dashboard error handling, use the shared modules instead of inventing page-specific error strings.

- [dashboardErrors.ts](/Users/Focus/conductor/workspaces/brief/west-monroe-v4/apps/web/lib/errors/dashboardErrors.ts)
  This should contain the approved user-facing error messages and any shared error-code definitions.
- [mapDashboardError.ts](/Users/Focus/conductor/workspaces/brief/west-monroe-v4/apps/web/lib/errors/mapDashboardError.ts)
  This should be the single place that maps raw errors or API responses to safe UI copy.

Dashboard components should call the shared mapper and render only the returned safe message.

## Rules

- Never render `error.message` directly in the UI.
- Never render raw `body.error` directly in the UI.
- Never render raw provider or database errors directly in the UI.
- Log the original error with enough context to debug the issue.
- If an API returns both `code` and `error`, use the `code` first and treat `error` as fallback only.
- If a new error case appears more than once, add it to the shared mapper instead of handling it inline.
