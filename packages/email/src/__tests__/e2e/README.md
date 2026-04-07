# E2E Email Tests

End-to-end tests that run against real email accounts through the `EmailAccountClient` interface. These tests verify actual outcomes (emails sent, drafts created, folders listed) rather than implementation details.

## Accounts

Tests run against 4 accounts:

| Account | Provider | Connection |
|---|---|---|
| Gmail + Unipile | gmail | Unipile REST API |
| Outlook + Unipile | outlook | Unipile REST API |
| Gmail + IMAP | gmail | Direct IMAP/SMTP |
| Outlook + IMAP | outlook | Direct IMAP/SMTP |

## Required Environment Variables

Create a `.env.test.local` file in the project root (gitignored) with the following variables.

### Unipile (shared by both Unipile accounts)

```
UNIPILE_API_KEY=your-unipile-api-key
UNIPILE_DSN=https://your-instance.unipile.com
```

### Gmail via Unipile

```
TEST_GMAIL_UNIPILE_ACCOUNT_ID=unipile-account-id-for-gmail
TEST_GMAIL_UNIPILE_EMAIL=your-test-gmail@gmail.com
```

### Outlook via Unipile

```
TEST_OUTLOOK_UNIPILE_ACCOUNT_ID=unipile-account-id-for-outlook
TEST_OUTLOOK_UNIPILE_EMAIL=your-test-outlook@outlook.com
```

### Gmail via IMAP/SMTP

```
TEST_GMAIL_IMAP_EMAIL=your-test-gmail@gmail.com
TEST_GMAIL_IMAP_HOST=imap.gmail.com
TEST_GMAIL_IMAP_PORT=993
TEST_GMAIL_IMAP_USER=your-test-gmail@gmail.com
TEST_GMAIL_IMAP_PASSWORD=your-app-password
TEST_GMAIL_SMTP_HOST=smtp.gmail.com
TEST_GMAIL_SMTP_PORT=587
TEST_GMAIL_SMTP_USER=your-test-gmail@gmail.com
TEST_GMAIL_SMTP_PASSWORD=your-app-password
```

### Outlook via IMAP/SMTP

```
TEST_OUTLOOK_IMAP_EMAIL=your-test-outlook@outlook.com
TEST_OUTLOOK_IMAP_HOST=outlook.office365.com
TEST_OUTLOOK_IMAP_PORT=993
TEST_OUTLOOK_IMAP_USER=your-test-outlook@outlook.com
TEST_OUTLOOK_IMAP_PASSWORD=your-app-password
TEST_OUTLOOK_SMTP_HOST=smtp.office365.com
TEST_OUTLOOK_SMTP_PORT=587
TEST_OUTLOOK_SMTP_USER=your-test-outlook@outlook.com
TEST_OUTLOOK_SMTP_PASSWORD=your-app-password
```

## Running

```bash
pnpm test:e2e
```

## Notes

- Tests send emails to themselves only (no external recipients).
- Each test run seeds its own data using a unique run ID so parallel runs do not collide.
- Tests have a 60-second timeout to account for mail server latency.
- If any env var is missing, tests fail immediately with a clear error.
