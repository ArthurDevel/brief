/**
 * E2E test account configuration.
 *
 * Reads environment variables for 4 test accounts and builds
 * EmailAccountRecord objects. Fails hard if any env var is missing.
 *
 * Responsibilities:
 * - Define required env vars per account
 * - Read and validate env vars
 * - Export typed account records for use in test suites
 */

import type { EmailAccountRecord } from "../../types";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Unique test run ID to isolate seeded data between runs */
export const TEST_RUN_ID = `e2e-${Date.now()}`;

// ============================================================================
// ACCOUNT DEFINITIONS
// ============================================================================

interface TestAccountDef {
  /** Human-readable label used in describe() blocks */
  label: string;
  /** The email address of this test account (sends to itself) */
  emailAddress: string;
  /** The built EmailAccountRecord */
  record: EmailAccountRecord;
}

/** All account builders. Each throws if its env vars are missing. */
const ALL_BUILDERS = [
  { key: "gmail-unipile", build: buildGmailUnipile },
  { key: "outlook-unipile", build: buildOutlookUnipile },
  { key: "gmail-imap", build: buildGmailImap },
  { key: "outlook-imap", build: buildOutlookImap },
];

/**
 * Builds test account definitions from env vars.
 * Each account fails independently -- if an account's env vars are missing it
 * is reported but does not block others. At least one account must be configured.
 * @returns Array of test account definitions
 */
export function loadTestAccounts(): TestAccountDef[] {
  const accounts: TestAccountDef[] = [];
  const skipped: string[] = [];

  for (const { key, build } of ALL_BUILDERS) {
    try {
      accounts.push(build());
    } catch (err) {
      skipped.push(`${key}: ${(err as Error).message}`);
    }
  }

  if (accounts.length === 0) {
    throw new Error(
      `No test accounts configured. All accounts failed:\n${skipped.join("\n")}\n\nSee packages/email/src/__tests__/e2e/README.md for setup.`
    );
  }

  if (skipped.length > 0) {
    console.warn(`[e2e] Skipping ${skipped.length} account(s) with missing env vars:\n${skipped.join("\n")}`);
  }

  return accounts;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads an env var or throws with a clear error message.
 * @param name - Environment variable name
 * @returns The env var value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. See packages/email/src/__tests__/e2e/README.md for setup.`);
  }
  return value;
}

function buildGmailUnipile(): TestAccountDef {
  const accountId = requireEnv("TEST_GMAIL_UNIPILE_ACCOUNT_ID");
  const emailAddress = requireEnv("TEST_GMAIL_UNIPILE_EMAIL");

  // Unipile also needs UNIPILE_API_KEY and UNIPILE_DSN (used by unipile-client.ts)
  requireEnv("UNIPILE_API_KEY");
  requireEnv("UNIPILE_DSN");

  return {
    label: "Gmail (Unipile)",
    emailAddress,
    record: {
      id: "test-gmail-unipile",
      userId: "test-user",
      provider: "gmail",
      connectionType: "unipile",
      emailAddress,
      unipileAccountId: accountId,
      status: "active",
      lastError: null,
    },
  };
}

function buildOutlookUnipile(): TestAccountDef {
  const accountId = requireEnv("TEST_OUTLOOK_UNIPILE_ACCOUNT_ID");
  const emailAddress = requireEnv("TEST_OUTLOOK_UNIPILE_EMAIL");

  return {
    label: "Outlook (Unipile)",
    emailAddress,
    record: {
      id: "test-outlook-unipile",
      userId: "test-user",
      provider: "outlook",
      connectionType: "unipile",
      emailAddress,
      unipileAccountId: accountId,
      status: "active",
      lastError: null,
    },
  };
}

function buildGmailImap(): TestAccountDef {
  const emailAddress = requireEnv("TEST_GMAIL_IMAP_EMAIL");

  return {
    label: "Gmail (IMAP)",
    emailAddress,
    record: {
      id: "test-gmail-imap",
      userId: "test-user",
      provider: "gmail",
      connectionType: "imap_smtp",
      emailAddress,
      unipileAccountId: null,
      status: "active",
      lastError: null,
      customConfig: {
        imap: {
          host: requireEnv("TEST_GMAIL_IMAP_HOST"),
          port: Number(requireEnv("TEST_GMAIL_IMAP_PORT")),
          user: requireEnv("TEST_GMAIL_IMAP_USER"),
          password: requireEnv("TEST_GMAIL_IMAP_PASSWORD"),
        },
        smtp: {
          host: requireEnv("TEST_GMAIL_SMTP_HOST"),
          port: Number(requireEnv("TEST_GMAIL_SMTP_PORT")),
          user: requireEnv("TEST_GMAIL_SMTP_USER"),
          password: requireEnv("TEST_GMAIL_SMTP_PASSWORD"),
        },
      },
    },
  };
}

function buildOutlookImap(): TestAccountDef {
  const emailAddress = requireEnv("TEST_OUTLOOK_IMAP_EMAIL");

  return {
    label: "Outlook (IMAP)",
    emailAddress,
    record: {
      id: "test-outlook-imap",
      userId: "test-user",
      provider: "outlook",
      connectionType: "imap_smtp",
      emailAddress,
      unipileAccountId: null,
      status: "active",
      lastError: null,
      customConfig: {
        imap: {
          host: requireEnv("TEST_OUTLOOK_IMAP_HOST"),
          port: Number(requireEnv("TEST_OUTLOOK_IMAP_PORT")),
          user: requireEnv("TEST_OUTLOOK_IMAP_USER"),
          password: requireEnv("TEST_OUTLOOK_IMAP_PASSWORD"),
        },
        smtp: {
          host: requireEnv("TEST_OUTLOOK_SMTP_HOST"),
          port: Number(requireEnv("TEST_OUTLOOK_SMTP_PORT")),
          user: requireEnv("TEST_OUTLOOK_SMTP_USER"),
          password: requireEnv("TEST_OUTLOOK_SMTP_PASSWORD"),
        },
      },
    },
  };
}
