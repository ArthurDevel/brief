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
 * Checks that a Unipile account is connected by listing its folders.
 * Throws if the account is disconnected or the API is unreachable.
 * @param accountId - Unipile account ID
 * @param label - Human-readable label for error messages
 */
async function checkUnipileConnection(accountId: string, label: string): Promise<void> {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  const res = await fetch(`${dsn}/api/v1/folders?account_id=${accountId}`, {
    headers: { "X-API-KEY": apiKey!, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `${label}: Unipile account ${accountId} is not connected (HTTP ${res.status}). ` +
      `Review the connection in the Unipile dashboard, then run again.\n${body}`
    );
  }
}

/**
 * Checks that an IMAP account is reachable by opening a connection.
 * Throws if the connection fails.
 * @param host - IMAP server host
 * @param port - IMAP server port
 * @param user - IMAP username
 * @param password - IMAP password
 * @param label - Human-readable label for error messages
 */
async function checkImapConnection(
  host: string,
  port: number,
  user: string,
  password: string,
  label: string,
): Promise<void> {
  // Use dynamic import to avoid pulling in imapflow at module level
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass: password }, logger: false });
  try {
    await client.connect();
    await client.logout();
  } catch (err) {
    throw new Error(
      `${label}: IMAP connection failed (${host}:${port}). ` +
      `Check credentials and server availability, then run again.\n${(err as Error).message}`
    );
  }
}

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

/**
 * Verifies that all loaded accounts are reachable before running tests.
 * Unipile accounts are checked via the folders API; IMAP accounts via a
 * test connection. Unreachable accounts are removed and reported.
 * @param accounts - The loaded test account definitions
 * @returns The accounts that passed the connectivity check
 */
export async function verifyAccountConnections(accounts: TestAccountDef[]): Promise<TestAccountDef[]> {
  const live: TestAccountDef[] = [];
  const failed: string[] = [];

  for (const account of accounts) {
    try {
      if (account.record.connectionType === "unipile") {
        await checkUnipileConnection(account.record.unipileAccountId!, account.label);
      } else if (account.record.connectionType === "imap_smtp" && account.record.customConfig?.imap) {
        const { host, port, user, password } = account.record.customConfig.imap;
        await checkImapConnection(host, port, user, password, account.label);
      }
      live.push(account);
    } catch (err) {
      failed.push((err as Error).message);
    }
  }

  if (failed.length > 0) {
    console.warn(
      `[e2e] Skipping ${failed.length} account(s) with connection issues:\n${failed.join("\n")}`
    );
  }

  if (live.length === 0) {
    throw new Error(
      `No test accounts are reachable. Review connections and run again:\n${failed.join("\n")}`
    );
  }

  return live;
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
