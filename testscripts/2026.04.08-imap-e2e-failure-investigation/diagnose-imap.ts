/**
 * Standalone diagnostic script for IMAP e2e test failures.
 *
 * Tests each IMAP operation independently with timing data to identify
 * where failures and hangs occur. Does not import from the main application.
 *
 * Responsibilities:
 * - Test IMAP connection (Gmail and Outlook)
 * - Test each IMAP operation: listInbox, searchEmails, readEmail, readThread, etc.
 * - Identify connection hangs, timeouts, and auth failures
 * - Output detailed timing and error info to help debug e2e failures
 *
 * Usage: npx tsx diagnose-imap.ts
 */

import { config } from "dotenv";
import { ImapFlow } from "imapflow";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, ".env") });

// ============================================================================
// CONSTANTS
// ============================================================================

const OPERATION_TIMEOUT_MS = 30_000;
const TAG = "[e2e-ts]";

interface DiagResult {
  account: string;
  operation: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error?: string;
  detail?: string;
}

const results: DiagResult[] = [];

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main() {
  console.log("=== IMAP E2E Failure Diagnostic ===\n");

  // Test Gmail IMAP
  const gmailConfig = {
    host: process.env.TEST_GMAIL_IMAP_HOST || "",
    port: Number(process.env.TEST_GMAIL_IMAP_PORT || "993"),
    user: process.env.TEST_GMAIL_IMAP_USER || "",
    password: process.env.TEST_GMAIL_IMAP_PASSWORD || "",
  };

  // Test Outlook IMAP
  const outlookConfig = {
    host: process.env.TEST_OUTLOOK_IMAP_HOST || "",
    port: Number(process.env.TEST_OUTLOOK_IMAP_PORT || "993"),
    user: process.env.TEST_OUTLOOK_IMAP_USER || "",
    password: process.env.TEST_OUTLOOK_IMAP_PASSWORD || "",
  };

  if (gmailConfig.user && gmailConfig.password) {
    await diagnoseAccount("Gmail IMAP", gmailConfig);
  } else {
    console.log("--- Gmail IMAP: SKIPPED (no credentials) ---\n");
    results.push({ account: "Gmail IMAP", operation: "all", status: "skip", durationMs: 0, error: "No credentials" });
  }

  if (outlookConfig.user && outlookConfig.password) {
    await diagnoseAccount("Outlook IMAP", outlookConfig);
  } else {
    console.log("--- Outlook IMAP: SKIPPED (no credentials) ---\n");
    results.push({ account: "Outlook IMAP", operation: "all", status: "skip", durationMs: 0, error: "No credentials (TEST_OUTLOOK_IMAP_PASSWORD is empty)" });
  }

  // Write results
  const outputPath = resolve(import.meta.dirname, "output", "diagnostic-results.json");
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outputPath}`);

  // Summary
  console.log("\n=== SUMMARY ===");
  const failures = results.filter((r) => r.status === "fail");
  const skips = results.filter((r) => r.status === "skip");
  const passes = results.filter((r) => r.status === "pass");
  console.log(`Pass: ${passes.length}  Fail: ${failures.length}  Skip: ${skips.length}`);

  if (failures.length > 0) {
    console.log("\nFailed operations:");
    for (const f of failures) {
      console.log(`  [${f.account}] ${f.operation}: ${f.error} (${f.durationMs}ms)`);
    }
  }
}

// ============================================================================
// ACCOUNT DIAGNOSIS
// ============================================================================

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

async function diagnoseAccount(label: string, cfg: ImapConfig) {
  console.log(`--- ${label} ---`);
  console.log(`  Host: ${cfg.host}:${cfg.port}`);
  console.log(`  User: ${cfg.user}\n`);

  // Step 1: Connection test
  let client: ImapFlow | null = null;
  client = await runDiag(label, "connect", async () => {
    const c = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: true,
      auth: { user: cfg.user, pass: cfg.password },
      logger: false,
    });
    await c.connect();
    return c;
  });

  if (!client) {
    console.log(`  Cannot continue -- connection failed\n`);
    return;
  }

  // Step 2: List mailboxes (folder discovery)
  let mailboxes: any[] = [];
  await runDiag(label, "list-mailboxes", async () => {
    mailboxes = await client!.list();
    console.log(`    Found ${mailboxes.length} mailboxes`);
    for (const mb of mailboxes.slice(0, 10)) {
      console.log(`      ${mb.path} ${mb.specialUse ?? ""} ${mb.flags ? `[${[...mb.flags].join(",")}]` : ""}`);
    }
    if (mailboxes.length > 10) console.log(`      ... and ${mailboxes.length - 10} more`);
  });

  // Step 3: Open INBOX and check message count
  let inboxCount = 0;
  await runDiag(label, "open-inbox", async () => {
    const lock = await client!.getMailboxLock("INBOX");
    try {
      inboxCount = client!.mailbox?.exists ?? 0;
      console.log(`    INBOX has ${inboxCount} messages`);
    } finally {
      lock.release();
    }
  });

  // Step 4: List recent inbox emails (like listInbox)
  let sampleUid: string | null = null;
  await runDiag(label, "list-inbox-20", async () => {
    const lock = await client!.getMailboxLock("INBOX");
    try {
      const total = client!.mailbox?.exists ?? 0;
      if (total === 0) {
        console.log("    INBOX is empty, nothing to list");
        return;
      }
      const startSeq = Math.max(1, total - 20 + 1);
      const range = `${startSeq}:*`;
      let count = 0;
      const uids: string[] = [];
      for await (const msg of client!.fetch(range, { envelope: true, bodyStructure: true })) {
        count++;
        uids.push(String(msg.uid));
        if (count <= 3) {
          console.log(`    [UID=${msg.uid}] ${msg.envelope?.subject ?? "(no subject)"}`);
        }
      }
      console.log(`    Fetched ${count} emails`);
      if (uids.length > 0) sampleUid = uids[uids.length - 1];
    } finally {
      lock.release();
    }
  });

  // Step 5: Read a single email by UID (like readEmail)
  if (sampleUid) {
    await runDiag(label, "read-email-uid", async () => {
      const lock = await client!.getMailboxLock("INBOX");
      try {
        const msg = await client!.fetchOne(sampleUid!, {
          envelope: true,
          source: true,
          flags: true,
        }, { uid: true });
        console.log(`    Read UID=${sampleUid}: subject="${msg.envelope?.subject}", flags=[${[...(msg.flags ?? [])].join(",")}]`);
      } finally {
        lock.release();
      }
    });
  }

  // Step 6: Search for e2e tagged emails
  await runDiag(label, "search-e2e-tag", async () => {
    const lock = await client!.getMailboxLock("INBOX");
    try {
      const searchResult = await client!.search({ subject: TAG });
      console.log(`    Found ${searchResult.length} emails matching subject "${TAG}"`);
      if (searchResult.length > 0) {
        console.log(`    UIDs: ${searchResult.slice(0, 10).join(", ")}${searchResult.length > 10 ? "..." : ""}`);
      }
    } finally {
      lock.release();
    }
  });

  // Step 7: Resolve special-use folders
  for (const flag of ["\\All", "\\Trash", "\\Drafts", "\\Sent"] as const) {
    await runDiag(label, `resolve-folder-${flag}`, async () => {
      const mb = mailboxes.find((m: any) => m.specialUse === flag);
      if (mb) {
        console.log(`    ${flag} -> ${mb.path}`);
      } else {
        throw new Error(`No mailbox with special-use flag ${flag}`);
      }
    });
  }

  // Step 8: Test move operation (archive + undo) on a test email
  const e2eEmails = await findE2eEmails(client);
  if (e2eEmails.length > 0) {
    const testUid = e2eEmails[0].uid;
    const testSubject = e2eEmails[0].subject;
    console.log(`\n  Using e2e email UID=${testUid} "${testSubject}" for mutation tests`);

    // Archive (move to All Mail)
    const allMailPath = mailboxes.find((m: any) => m.specialUse === "\\All")?.path;
    if (allMailPath) {
      await runDiag(label, "archive-move", async () => {
        const lock = await client!.getMailboxLock("INBOX");
        try {
          // Get Message-ID before move
          const msg = await client!.fetchOne(String(testUid), { envelope: true }, { uid: true });
          const messageId = msg.envelope?.messageId;
          console.log(`    Message-ID: ${messageId}`);

          await client!.messageMove(String(testUid), allMailPath, { uid: true });
          console.log(`    Moved UID=${testUid} to ${allMailPath}`);
        } finally {
          lock.release();
        }
      });

      // Undo: move back to INBOX
      await runDiag(label, "undo-move-back", async () => {
        // Need to find the email in All Mail by Message-ID
        const lock = await client!.getMailboxLock(allMailPath);
        try {
          const searchResult = await client!.search({ subject: testSubject });
          if (searchResult.length === 0) throw new Error("Email not found in All Mail after move");
          const foundUid = searchResult[searchResult.length - 1];
          await client!.messageMove(String(foundUid), "INBOX", { uid: true });
          console.log(`    Moved back to INBOX (found as UID=${foundUid} in ${allMailPath})`);
        } finally {
          lock.release();
        }
      });
    }
  } else {
    console.log(`\n  No e2e-tagged emails found in INBOX -- skipping mutation tests`);
    results.push({ account: label, operation: "mutation-tests", status: "skip", durationMs: 0, detail: "No e2e-tagged emails in INBOX" });
  }

  // Step 9: Disconnect
  await runDiag(label, "disconnect", async () => {
    await client!.logout();
    console.log(`    Disconnected`);
  });

  console.log("");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Runs a diagnostic step with timing, timeout, and error capture.
 * @param account - Account label for reporting
 * @param operation - Operation name
 * @param fn - The operation to run
 * @returns The result of fn, or null on failure
 */
async function runDiag<T>(account: string, operation: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  const prefix = `  [${operation}]`;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${OPERATION_TIMEOUT_MS}ms`)), OPERATION_TIMEOUT_MS)
      ),
    ]);
    const dur = Date.now() - t0;
    console.log(`${prefix} PASS (${dur}ms)`);
    results.push({ account, operation, status: "pass", durationMs: dur });
    return result;
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${prefix} FAIL (${dur}ms): ${msg}`);
    results.push({ account, operation, status: "fail", durationMs: dur, error: msg });
    return null;
  }
}

/**
 * Finds e2e-tagged emails in INBOX.
 */
async function findE2eEmails(client: ImapFlow): Promise<Array<{ uid: number; subject: string }>> {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const searchResult = await client.search({ subject: TAG });
    if (searchResult.length === 0) return [];

    const emails: Array<{ uid: number; subject: string }> = [];
    const uidSet = searchResult.map(String).join(",");
    for await (const msg of client.fetch(uidSet, { envelope: true }, { uid: true })) {
      emails.push({ uid: msg.uid, subject: msg.envelope?.subject ?? "" });
    }
    return emails;
  } finally {
    lock.release();
  }
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
