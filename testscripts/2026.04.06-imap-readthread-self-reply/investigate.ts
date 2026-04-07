/**
 * Investigation script: IMAP readThread fails for self-sent Gmail replies.
 *
 * Tests whether Gmail indexes References/In-Reply-To headers for IMAP HEADER
 * search when an email is sent from a Gmail account to itself. Sends a test
 * thread, then searches All Mail and Sent Mail using different IMAP search
 * strategies to determine which ones find the reply.
 *
 * Steps:
 * - Send original email from Gmail to Outlook
 * - Send a self-reply from Gmail to Gmail with In-Reply-To/References headers
 * - Search [Gmail]/All Mail by message-id, references, in-reply-to, subject
 * - Search [Gmail]/Sent Mail by the same criteria
 * - Log all results for analysis
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// CONSTANTS
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WAIT_SECONDS = 20;

const GMAIL_IMAP_HOST = process.env.GMAIL_IMAP_HOST!;
const GMAIL_IMAP_PORT = Number(process.env.GMAIL_IMAP_PORT!);
const GMAIL_IMAP_USER = process.env.GMAIL_IMAP_USER!;
const GMAIL_IMAP_PASSWORD = process.env.GMAIL_IMAP_PASSWORD!;
const GMAIL_SMTP_HOST = process.env.GMAIL_SMTP_HOST!;
const GMAIL_SMTP_PORT = Number(process.env.GMAIL_SMTP_PORT!);
const GMAIL_SMTP_USER = process.env.GMAIL_SMTP_USER!;
const GMAIL_SMTP_PASSWORD = process.env.GMAIL_SMTP_PASSWORD!;
const OUTLOOK_EMAIL = process.env.OUTLOOK_EMAIL!;

const TIMESTAMP = Date.now();
const SUBJECT_TAG = `thread-test-${TIMESTAMP}`;
const ORIGINAL_SUBJECT = `[${SUBJECT_TAG}] Original from Gmail`;
const REPLY_SUBJECT = `Re: ${ORIGINAL_SUBJECT}`;
const ORIGINAL_MESSAGE_ID = `<original-${TIMESTAMP}@investigate.test>`;
const REPLY_MESSAGE_ID = `<reply-${TIMESTAMP}@investigate.test>`;

const OUTPUT_DIR = path.join(__dirname, "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "results.txt");

// ============================================================================
// LOGGING
// ============================================================================

const logLines: string[] = [];

/**
 * Logs a message to both console and the output buffer.
 * @param message - The message to log
 */
function log(message: string): void {
  console.log(message);
  logLines.push(message);
}

/**
 * Writes all accumulated log lines to the output file.
 */
function flushLog(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, logLines.join("\n") + "\n");
  console.log(`\n--- Output written to ${OUTPUT_FILE} ---`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates an SMTP transporter for Gmail.
 * @returns Nodemailer transporter
 */
function createSmtpTransporter(): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: GMAIL_SMTP_HOST,
    port: GMAIL_SMTP_PORT,
    secure: false,
    auth: {
      user: GMAIL_SMTP_USER,
      pass: GMAIL_SMTP_PASSWORD,
    },
  });
}

/**
 * Creates an IMAP client for Gmail.
 * @returns ImapFlow client (not yet connected)
 */
function createImapClient(): ImapFlow {
  return new ImapFlow({
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    secure: true,
    auth: {
      user: GMAIL_IMAP_USER,
      pass: GMAIL_IMAP_PASSWORD,
    },
    logger: false,
  });
}

/**
 * Waits for a given number of seconds, logging a countdown.
 * @param seconds - Number of seconds to wait
 */
async function wait(seconds: number): Promise<void> {
  log(`  Waiting ${seconds} seconds for delivery...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

interface SearchResult {
  uid: number;
  messageId: string;
  inReplyTo: string;
  subject: string;
  references: string;
}

/**
 * Searches a mailbox by a specific IMAP HEADER criterion and fetches envelope details.
 * @param client - Connected ImapFlow client
 * @param mailbox - Mailbox path to search in
 * @param headerName - The header name to search by
 * @param headerValue - The header value to search for
 * @returns Array of search results with envelope details
 */
async function searchByHeader(
  client: ImapFlow,
  mailbox: string,
  headerName: string,
  headerValue: string
): Promise<SearchResult[]> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    log(`  Searching ${mailbox} by HEADER ${headerName}: ${headerValue}`);

    const uids = await client.search({
      header: { [headerName]: headerValue },
    });

    log(`  Found ${uids.length} UIDs: [${uids.join(", ")}]`);

    const results: SearchResult[] = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), {
        envelope: true,
        headers: true,
      });

      const envelope = msg.envelope;
      const headers = msg.headers?.toString() || "";

      // Extract References header manually since envelope doesn't include it
      const referencesMatch = headers.match(/^References:\s*(.+)$/im);
      const references = referencesMatch ? referencesMatch[1].trim() : "(none)";

      results.push({
        uid,
        messageId: envelope?.messageId || "(none)",
        inReplyTo: envelope?.inReplyTo || "(none)",
        subject: envelope?.subject || "(none)",
        references,
      });

      log(`    UID ${uid}:`);
      log(`      Subject: ${envelope?.subject}`);
      log(`      Message-ID: ${envelope?.messageId}`);
      log(`      In-Reply-To: ${envelope?.inReplyTo || "(none)"}`);
      log(`      References: ${references}`);
    }

    return results;
  } finally {
    lock.release();
  }
}

/**
 * Searches a mailbox by SUBJECT and fetches envelope details.
 * @param client - Connected ImapFlow client
 * @param mailbox - Mailbox path to search in
 * @param subject - The subject string to search for
 * @returns Array of search results
 */
async function searchBySubject(
  client: ImapFlow,
  mailbox: string,
  subject: string
): Promise<SearchResult[]> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    log(`  Searching ${mailbox} by SUBJECT: ${subject}`);

    const uids = await client.search({ subject });

    log(`  Found ${uids.length} UIDs: [${uids.join(", ")}]`);

    const results: SearchResult[] = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), {
        envelope: true,
        headers: true,
      });

      const envelope = msg.envelope;
      const headers = msg.headers?.toString() || "";
      const referencesMatch = headers.match(/^References:\s*(.+)$/im);
      const references = referencesMatch ? referencesMatch[1].trim() : "(none)";

      results.push({
        uid,
        messageId: envelope?.messageId || "(none)",
        inReplyTo: envelope?.inReplyTo || "(none)",
        subject: envelope?.subject || "(none)",
        references,
      });

      log(`    UID ${uid}:`);
      log(`      Subject: ${envelope?.subject}`);
      log(`      Message-ID: ${envelope?.messageId}`);
      log(`      In-Reply-To: ${envelope?.inReplyTo || "(none)"}`);
      log(`      References: ${references}`);
    }

    return results;
  } finally {
    lock.release();
  }
}

// ============================================================================
// MAIN SCRIPT
// ============================================================================

async function main(): Promise<void> {
  log("=== IMAP readThread Self-Reply Investigation ===");
  log(`Timestamp: ${TIMESTAMP}`);
  log(`Subject tag: ${SUBJECT_TAG}`);
  log(`Original Message-ID: ${ORIGINAL_MESSAGE_ID}`);
  log(`Reply Message-ID: ${REPLY_MESSAGE_ID}`);
  log("");

  // -- Step 1: Send original email from Gmail to Outlook --
  log("--- STEP 1: Send original email (Gmail -> Outlook) ---");
  const transporter = createSmtpTransporter();

  await transporter.sendMail({
    from: GMAIL_SMTP_USER,
    to: OUTLOOK_EMAIL,
    subject: ORIGINAL_SUBJECT,
    messageId: ORIGINAL_MESSAGE_ID,
    text: "This is the original email for the thread test.",
  });
  log(`  Sent original email to ${OUTLOOK_EMAIL}`);
  log(`  Subject: ${ORIGINAL_SUBJECT}`);
  await wait(WAIT_SECONDS);

  // -- Step 2: Send self-reply (Gmail -> Gmail) with threading headers --
  log("");
  log("--- STEP 2: Send self-reply (Gmail -> Gmail) with In-Reply-To/References ---");

  await transporter.sendMail({
    from: GMAIL_SMTP_USER,
    to: GMAIL_SMTP_USER,
    subject: REPLY_SUBJECT,
    messageId: REPLY_MESSAGE_ID,
    inReplyTo: ORIGINAL_MESSAGE_ID,
    references: ORIGINAL_MESSAGE_ID,
    text: "This is a self-reply to test IMAP thread search.",
  });
  log(`  Sent reply to ${GMAIL_SMTP_USER} (self)`);
  log(`  Subject: ${REPLY_SUBJECT}`);
  log(`  In-Reply-To: ${ORIGINAL_MESSAGE_ID}`);
  log(`  References: ${ORIGINAL_MESSAGE_ID}`);
  await wait(WAIT_SECONDS);

  // -- Step 3: Search [Gmail]/All Mail --
  log("");
  log("--- STEP 3: Search [Gmail]/All Mail ---");

  const client = createImapClient();
  await client.connect();

  log("");
  log("3a) Search by HEADER message-id (original's Message-ID):");
  await searchByHeader(client, "[Gmail]/All Mail", "message-id", ORIGINAL_MESSAGE_ID);

  log("");
  log("3b) Search by HEADER references (original's Message-ID):");
  await searchByHeader(client, "[Gmail]/All Mail", "references", ORIGINAL_MESSAGE_ID);

  // -- Step 4: Search [Gmail]/Sent Mail --
  log("");
  log("--- STEP 4: Search [Gmail]/Sent Mail ---");

  log("");
  log("4a) Search Sent Mail by HEADER message-id (original's Message-ID):");
  await searchByHeader(client, "[Gmail]/Sent Mail", "message-id", ORIGINAL_MESSAGE_ID);

  log("");
  log("4b) Search Sent Mail by HEADER references (original's Message-ID):");
  await searchByHeader(client, "[Gmail]/Sent Mail", "references", ORIGINAL_MESSAGE_ID);

  log("");
  log("4c) Search Sent Mail by HEADER message-id (reply's Message-ID):");
  await searchByHeader(client, "[Gmail]/Sent Mail", "message-id", REPLY_MESSAGE_ID);

  // -- Step 5: Search by In-Reply-To header --
  log("");
  log("--- STEP 5: Search All Mail by HEADER in-reply-to ---");
  await searchByHeader(client, "[Gmail]/All Mail", "in-reply-to", ORIGINAL_MESSAGE_ID);

  // -- Step 6: Search by Subject --
  log("");
  log("--- STEP 6: Search All Mail by SUBJECT ---");
  await searchBySubject(client, "[Gmail]/All Mail", SUBJECT_TAG);

  await client.logout();

  log("");
  log("=== Investigation complete ===");

  flushLog();
}

main().catch((err) => {
  log(`FATAL ERROR: ${err.message}`);
  log(err.stack || "");
  flushLog();
  process.exit(1);
});
