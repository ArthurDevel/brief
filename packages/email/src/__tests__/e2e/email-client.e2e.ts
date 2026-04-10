/**
 * E2E tests for EmailAccountClient across all provider/connection combos.
 *
 * Tests actual outcomes through the highest-level API (createEmailAccountClient).
 * Each account sends only to itself. Emails are seeded once and reused across runs
 * via a file-based cache (.seed-cache.json). Mutation tests restore emails to inbox
 * after each test so they can be reused.
 *
 * Responsibilities:
 * - Seed a pool of reusable test emails (cached across runs)
 * - Verify all EmailAccountClient operations produce correct results
 * - Run the same test suite against Gmail/Outlook x Unipile/IMAP
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { createEmailAccountClient } from "../../account-client";
import type { EmailAccountClient, EmailAccountRecord } from "../../types";
import { loadTestAccounts, verifyAccountConnections, TEST_RUN_ID } from "./accounts";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Stable tag for seed emails -- reused across runs to avoid re-seeding */
const TAG = "[e2e-ts]";

/** How long to wait for email delivery before asserting (ms) */
const DELIVERY_WAIT_MS = 15_000;

/** Cache file for seed email IDs so we don't re-seed every run */
const SEED_CACHE_PATH = new URL(".seed-cache.json", import.meta.url).pathname;

/**
 * Pool keys: each key corresponds to one seeded email.
 * - seed, thread, search: shared read-only emails
 * - The rest: one per mutation test, restored to inbox after each test
 */
const POOL_KEYS = [
  "seed", "thread", "search",
  "deleteRecipe", "archiveForward", "archiveUndo",
  "deleteForward", "deleteUndo",
  "moveForward", "moveUndo", "moveNonexistent",
  "moveUserFolder", "moveUserFolderUndo",
] as const;

type PoolKey = typeof POOL_KEYS[number];

/** Keys for mutation tests -- these emails need to be in INBOX at test start */
const MUTATION_POOL_KEYS: PoolKey[] = [
  "deleteRecipe", "archiveForward", "archiveUndo",
  "deleteForward", "deleteUndo",
  "moveForward", "moveUndo", "moveNonexistent",
  "moveUserFolder", "moveUserFolderUndo",
];

/** Returns the stable subject for a pool email */
function poolSubject(key: PoolKey): string {
  // Use descriptive subjects for the original 3, short keys for the rest
  if (key === "seed") return `${TAG} Seed email`;
  if (key === "thread") return `${TAG} Thread test`;
  if (key === "search") return `${TAG} Searchable uniquetoken`;
  return `${TAG} Pool ${key}`;
}

// ============================================================================
// TEST SUITE
// ============================================================================

const accounts = loadTestAccounts();

describe.each(accounts)("EmailAccountClient -- $label", ({ record, emailAddress }) => {
  let client: EmailAccountClient;
  let pool: Record<string, string> = {};
  let suiteSkipped = false;

  // Convenience aliases populated in beforeAll
  let seedEmailId: string;
  let threadEmailId: string;

  /** Call at the top of each test -- throws if setup failed so the test is a proper failure */
  function assertSetupSucceeded(): void {
    if (suiteSkipped) {
      throw new Error(`[${emailAddress}] Setup failed -- skipping test`);
    }
  }

  // ------------------------------------------------------------------
  // SETUP: create client and seed/verify pool
  // ------------------------------------------------------------------

  beforeAll(async () => {
    const t0 = Date.now();
    const log = (msg: string) => console.log(`[e2e][${emailAddress}] ${msg} (+${Date.now() - t0}ms)`);

    try {
      // Verify account is reachable
      log("verifying connection...");
      await verifyAccountConnections([{ label: emailAddress, record, emailAddress }]);
      log("connection OK");

      client = await createEmailAccountClient(record);

      // Check each cached email individually. Collect keys that need re-seeding.
      const cache = readSeedCache();
      const cached = cache[record.id] ?? {};
      const missing: PoolKey[] = [];

      for (const key of POOL_KEYS) {
        const id = cached[key];
        if (!id) { missing.push(key); continue; }

        try {
          await client.readEmail(id);

          // For Unipile: also verify mutation emails are in INBOX
          if (isGmailUnipile(record) && MUTATION_POOL_KEYS.includes(key)) {
            const folders = await getUnipileEmailFolders(id, record.unipileAccountId!);
            if (!folders.includes("INBOX")) throw new Error("not in INBOX");
          }

          pool[key] = id;
        } catch {
          missing.push(key);
        }
      }

      if (missing.length === 0) {
        log("all pool emails valid from cache");
      } else {
        // Send only the missing emails, wait once, find them
        log(`re-seeding ${missing.length} emails: ${missing.join(", ")}`);
        for (const key of missing) {
          await client.sendEmail({
            to: emailAddress,
            subject: poolSubject(key),
            body: `Pool email: ${key}`,
          });
        }
        await wait(DELIVERY_WAIT_MS);

        for (const key of missing) {
          const subject = poolSubject(key);
          pool[key] = isGmailUnipile(record)
            ? await findEmailBySubjectUnipile(record.unipileAccountId!, subject)
            : await findEmailBySubject(client, subject);
        }

        // Update cache
        cache[record.id] = { ...pool };
        writeSeedCache(cache);
      }

      seedEmailId = pool.seed;
      threadEmailId = pool.thread;
      log(`beforeAll complete (${missing.length} re-seeded)`);
    } catch (err) {
      suiteSkipped = true;
      console.warn(`[e2e][${emailAddress}] SETUP FAILED -- skipping all tests: ${err}`);
    }
  }, 180_000);

  // ------------------------------------------------------------------
  // INBOX & SEARCH
  // ------------------------------------------------------------------

  it("listInbox returns EmailSummary[] with required fields", async () => {
    assertSetupSucceeded();
    const emails = await client.listInbox(20);

    expect(emails.length).toBeGreaterThan(0);
    const email = emails[0];
    expect(email).toHaveProperty("id");
    expect(email).toHaveProperty("from");
    expect(email).toHaveProperty("subject");
    expect(email).toHaveProperty("snippet");
    expect(email).toHaveProperty("date");
  });

  it("listInbox contains the seeded email", async () => {
    assertSetupSucceeded();
    const emails = await client.listInbox(50);
    const found = emails.find((e) => e.subject.includes(TAG));
    expect(found).toBeDefined();
  });

  it("searchEmails finds the searchable email", async () => {
    assertSetupSucceeded();
    const results = await client.searchEmails("uniquetoken");
    const found = results.find((e) => e.subject.includes(poolSubject("search")));
    expect(found).toBeDefined();
  });

  // ------------------------------------------------------------------
  // READ
  // ------------------------------------------------------------------

  it("readEmail returns full Email with body", async () => {
    assertSetupSucceeded();
    const email = await client.readEmail(seedEmailId);

    expect(email.id).toBeTruthy();
    expect(email.subject).toContain(poolSubject("seed"));
    expect(email.body).toBeTruthy();
    expect(email.from).toBeTruthy();
    expect(email.to).toBeTruthy();
    expect(email.date).toBeTruthy();
    expect(typeof email.isRead).toBe("boolean");
  });

  // ------------------------------------------------------------------
  // THREAD
  // ------------------------------------------------------------------

  it("readThread returns at least the thread starter", async () => {
    assertSetupSucceeded();
    const messages = await client.readThread(threadEmailId);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const starter = messages.find((m) => m.subject.includes(poolSubject("thread")));
    expect(starter).toBeDefined();
    expect(starter!.body).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // MARK AS READ
  // ------------------------------------------------------------------

  it("markAsRead marks the email as read", async () => {
    assertSetupSucceeded();
    await client.markAsRead(seedEmailId);
    const email = await client.readEmail(seedEmailId);
    expect(email.isRead).toBe(true);
  });

  // ------------------------------------------------------------------
  // FOLDERS
  // ------------------------------------------------------------------

  it("listFolders returns FolderInfo[] with at least one folder", async () => {
    assertSetupSucceeded();
    const folders = await client.listFolders();

    expect(folders.length).toBeGreaterThan(0);
    const folder = folders[0];
    expect(folder).toHaveProperty("path");
    expect(folder).toHaveProperty("name");
    expect(folder).toHaveProperty("specialUse");
  });

  it("resolveSpecialUseFolder finds Trash", async () => {
    assertSetupSucceeded();
    const trash = await client.resolveSpecialUseFolder("\\Trash");
    expect(trash).toBeTruthy();
  });

  it("resolveSpecialUseFolder finds Drafts", async () => {
    assertSetupSucceeded();
    const drafts = await client.resolveSpecialUseFolder("\\Drafts");
    expect(drafts).toBeTruthy();
  });

  it("resolveSpecialUseFolder finds Sent", async () => {
    assertSetupSucceeded();
    const sent = await client.resolveSpecialUseFolder("\\Sent");
    expect(sent).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // DRAFT LIFECYCLE
  // ------------------------------------------------------------------

  it("saveDraft creates a draft, deleteDraft removes it", async () => {
    assertSetupSucceeded();
    const undoRecipe = await client.saveDraft({
      to: emailAddress,
      subject: `${TAG} Draft test`,
      body: `Draft body ${TEST_RUN_ID}`,
    });

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("delete_draft");
    expect(undoRecipe!.params.draftUid).toBeTruthy();

    await client.deleteDraft(undoRecipe!.params.draftUid as unknown as number);
  });

  it("saveDraft with CC creates a draft", async () => {
    assertSetupSucceeded();
    const undoRecipe = await client.saveDraft({
      to: emailAddress,
      subject: `${TAG} Draft CC test`,
      body: `Draft with CC ${TEST_RUN_ID}`,
      cc: emailAddress,
    });

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("delete_draft");

    await client.deleteDraft(undoRecipe!.params.draftUid as unknown as number);
  });

  it("convert-to-draft: saveDraft with threading headers creates a reply draft", async () => {
    assertSetupSucceeded();
    const ctx = await client.fetchReplyContext(threadEmailId);

    const undoRecipe = await client.saveDraft({
      to: emailAddress,
      subject: ctx.subject.startsWith("Re: ") ? ctx.subject : `Re: ${ctx.subject}`,
      body: `Converted reply draft ${TEST_RUN_ID}`,
      inReplyTo: ctx.messageId,
      references: [ctx.messageId, ...ctx.references].join(" "),
    });

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("delete_draft");

    await client.deleteDraft(undoRecipe!.params.draftUid as unknown as number);
  });

  // ------------------------------------------------------------------
  // SEND & REPLY
  // ------------------------------------------------------------------

  it("sendEmail delivers to self", async () => {
    assertSetupSucceeded();
    const subject = `${TAG} Send test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Send test body" });

    await wait(DELIVERY_WAIT_MS);

    const results = await client.searchEmails(subject);
    const found = results.find((e) => e.subject.includes(subject));
    expect(found).toBeDefined();
  });

  it("fetchReplyContext returns valid context", async () => {
    assertSetupSucceeded();
    const ctx = await client.fetchReplyContext(threadEmailId);

    expect(ctx.messageId).toBeTruthy();
    expect(ctx.subject).toContain(poolSubject("thread"));
    expect(ctx.from).toBeTruthy();
    expect(Array.isArray(ctx.to)).toBe(true);
    expect(Array.isArray(ctx.cc)).toBe(true);
    expect(Array.isArray(ctx.references)).toBe(true);
  });

  it("replyEmail sends a threaded reply to self", async () => {
    assertSetupSucceeded();
    const ctx = await client.fetchReplyContext(threadEmailId);

    await client.replyEmail({
      context: ctx,
      body: `Reply body ${TEST_RUN_ID}`,
      replyAll: false,
      senderAddress: emailAddress,
    });

    // Verify the thread now has more messages (retry-based for delivery + indexing)
    const thread = await waitForThreadSize(client, threadEmailId, 2);
    expect(thread.length).toBeGreaterThanOrEqual(2);
  });

  // ------------------------------------------------------------------
  // FETCH EMAIL META BATCH
  // ------------------------------------------------------------------

  it("fetchEmailMetaBatch returns metadata for known emails", async () => {
    assertSetupSucceeded();
    const results = await client.fetchEmailMetaBatch([
      { actionId: "test-1", uid: seedEmailId },
    ]);

    expect(results.size).toBe(1);
    const meta = results.get("test-1");
    expect(meta).toBeDefined();
    expect(meta!.subject).toContain(poolSubject("seed"));
    expect(meta!.from).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // DELETE (recipe check)
  // ------------------------------------------------------------------

  it("deleteEmail moves to trash and returns undo recipe", async () => {
    assertSetupSucceeded();
    const emailId = pool.deleteRecipe;
    const undoRecipe = await client.deleteEmail(emailId, "INBOX");

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");
    expect(undoRecipe!.params.from).toBeTruthy();
    expect(undoRecipe!.params.to).toBeTruthy();

    // Restore to inbox for next run
    await restoreToInbox(client, record, undoRecipe!);
  });

  // ------------------------------------------------------------------
  // ARCHIVE
  // ------------------------------------------------------------------

  it("archiveEmail removes from inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.archiveForward;
    const undoRecipe = await client.archiveEmail(emailId, "INBOX");

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }
  });

  it("archiveEmail undo restores to inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.archiveUndo;
    const undoRecipe = await client.archiveEmail(emailId, "INBOX");
    expect(undoRecipe).toBeTruthy();

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }

    // Undo: move it back to INBOX
    await restoreToInbox(client, record, undoRecipe!);

    // Unipile: verify via folder state (IDs are stable across moves)
    if (isGmailUnipile(record)) {
      await verifyUndoRestoredToInbox(emailId, record.unipileAccountId!);
    }
  });

  // ------------------------------------------------------------------
  // DELETE
  // ------------------------------------------------------------------

  it("deleteEmail removes from inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.deleteForward;
    const undoRecipe = await client.deleteEmail(emailId, "INBOX");
    expect(undoRecipe).toBeTruthy();

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }
  });

  it("deleteEmail undo restores to inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.deleteUndo;
    const undoRecipe = await client.deleteEmail(emailId, "INBOX");
    expect(undoRecipe).toBeTruthy();

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }

    // Undo: move it back
    await restoreToInbox(client, record, undoRecipe!);

    if (isGmailUnipile(record)) {
      await verifyUndoRestoredToInbox(emailId, record.unipileAccountId!);
    }
  });

  // ------------------------------------------------------------------
  // MOVE TO FOLDER
  // ------------------------------------------------------------------

  it("moveToFolder removes from inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.moveForward;
    const trash = await client.resolveSpecialUseFolder("\\Trash");
    expect(trash).toBeTruthy();

    const undoRecipe = await client.moveToFolder(emailId, trash!, "INBOX");
    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }
  });

  it("moveToFolder undo restores to inbox", async () => {
    assertSetupSucceeded();
    const emailId = pool.moveUndo;
    const trash = await client.resolveSpecialUseFolder("\\Trash");
    expect(trash).toBeTruthy();

    const undoRecipe = await client.moveToFolder(emailId, trash!, "INBOX");
    expect(undoRecipe).toBeTruthy();

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }

    // Undo: move it back
    await restoreToInbox(client, record, undoRecipe!);

    if (isGmailUnipile(record)) {
      await verifyUndoRestoredToInbox(emailId, record.unipileAccountId!);
    }
  });

  it("moveToFolder throws when target folder does not exist", async () => {
    assertSetupSucceeded();
    const emailId = pool.moveNonexistent;
    const bogusFolder = `NONEXISTENT_${Date.now()}`;

    await expect(
      client.moveToFolder(emailId, bogusFolder, "INBOX")
    ).rejects.toThrow();

    // Email should still be in the inbox (move should not have happened)
    if (isGmailUnipile(record)) {
      const folders = await getUnipileEmailFolders(emailId, record.unipileAccountId!);
      expect(folders).toContain("INBOX");
    } else {
      // Verify by checking inbox listing for this specific ID
      const emails = await client.listInbox(50);
      expect(emails.find((e) => e.id === emailId)).toBeDefined();
    }
  });

  it("moveToFolder works with user-created label", async () => {
    assertSetupSucceeded();
    const folders = await client.listFolders();
    const userFolder = folders.find(
      (f) => !f.specialUse && !f.path.startsWith("[") && f.path !== "INBOX"
    );

    if (!userFolder) {
      console.warn(`[e2e] Skipping user-folder move test -- no user-created folders found`);
      return;
    }

    const emailId = pool.moveUserFolder;
    const undoRecipe = await client.moveToFolder(emailId, userFolder.path, "INBOX");
    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }
  });

  it("moveToFolder with user-created label undo restores to inbox", async () => {
    assertSetupSucceeded();
    const folders = await client.listFolders();
    const userFolder = folders.find(
      (f) => !f.specialUse && !f.path.startsWith("[") && f.path !== "INBOX"
    );

    if (!userFolder) {
      console.warn(`[e2e] Skipping user-folder undo test -- no user-created folders found`);
      return;
    }

    const emailId = pool.moveUserFolderUndo;
    const undoRecipe = await client.moveToFolder(emailId, userFolder.path, "INBOX");
    expect(undoRecipe).toBeTruthy();

    if (isGmailUnipile(record)) {
      await waitUntilGoneFromInboxUnipile(emailId, record.unipileAccountId!);
    } else {
      await waitUntilGoneFromInbox(client, emailId);
    }

    // Undo: move it back
    await restoreToInbox(client, record, undoRecipe!);

    if (isGmailUnipile(record)) {
      await verifyUndoRestoredToInbox(emailId, record.unipileAccountId!);
    }
  });
});

// ============================================================================
// SEED CACHE
// ============================================================================

interface SeedCache {
  [accountId: string]: Record<string, string>;
}

/**
 * Reads the seed cache from disk. Returns empty object if file doesn't exist.
 */
function readSeedCache(): SeedCache {
  try {
    return JSON.parse(readFileSync(SEED_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Writes the seed cache to disk.
 * @param cache - The cache object to persist
 */
function writeSeedCache(cache: SeedCache): void {
  writeFileSync(SEED_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Waits for the given duration.
 * @param ms - Milliseconds to wait
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Restores an email to inbox using the undo recipe from a mutation.
 * @param client - The email client
 * @param record - The account record
 * @param undoRecipe - The undo recipe from archive/delete/move
 */
async function restoreToInbox(
  client: EmailAccountClient,
  record: EmailAccountRecord,
  undoRecipe: { operation: string; params: Record<string, unknown> },
): Promise<void> {
  const { from, to } = undoRecipe.params as Record<string, string>;
  const identifier = (undoRecipe.params.emailId ?? undoRecipe.params.messageId) as string;
  const rfcMessageId = undoRecipe.params.rfcMessageId as string | undefined;
  await client.moveEmail(identifier, to, from, rfcMessageId);
}

/**
 * Searches inbox for an email matching the given subject.
 * Retries up to 12 times (total ~60s) to handle delivery delay and eventual consistency.
 * @param client - The email client
 * @param subject - Subject string to match
 * @returns The email ID
 */
async function findEmailBySubject(client: EmailAccountClient, subject: string): Promise<string> {
  const MAX_RETRIES = 12;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const emails = await client.searchEmails(subject);
    const found = emails.find((e) => e.subject.includes(subject));
    if (found) return found.id;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(`Could not find email with subject containing "${subject}" after ${MAX_RETRIES} attempts (${MAX_RETRIES * RETRY_WAIT_MS / 1000}s)`);
}

/**
 * Waits until a thread has at least the expected number of messages.
 * Retries up to 8 times (total ~40s) to handle delivery + indexing delay.
 * @param client - The email client
 * @param emailId - The email ID to read the thread for
 * @param minSize - Minimum expected thread size
 * @returns The thread messages
 */
async function waitForThreadSize(
  client: EmailAccountClient,
  emailId: string,
  minSize: number
): Promise<import("../../types").ThreadMessage[]> {
  const MAX_RETRIES = 8;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const thread = await client.readThread(emailId);
    if (thread.length >= minSize) return thread;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  // Return whatever we got -- the caller will assert
  return client.readThread(emailId);
}

/**
 * Waits until a specific email (by ID) is no longer in the inbox.
 * Retries up to 6 times (total ~30s) to handle eventual consistency.
 * @param client - The email client
 * @param emailId - The email ID to check for
 */
async function waitUntilGoneFromInbox(client: EmailAccountClient, emailId: string): Promise<void> {
  const MAX_RETRIES = 6;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const emails = await client.listInbox(50);
    const found = emails.find((e) => e.id === emailId);
    if (!found) return;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(`Email ${emailId} still in inbox after ${MAX_RETRIES} attempts`);
}


// ============================================================================
// GMAIL UNIPILE HELPERS
// ============================================================================
// Gmail Unipile's inbox listing (GET /emails?folder=INBOX) has 60+ second sync
// delays. These helpers bypass that by listing emails without a folder filter
// and checking folder state directly on individual emails.

/**
 * Returns true if the account is Gmail connected via Unipile.
 * @param record - The email account record
 */
function isGmailUnipile(record: EmailAccountRecord): boolean {
  return record.connectionType === "unipile" && record.provider === "gmail";
}

/**
 * Makes a direct Unipile API request.
 * @param method - HTTP method
 * @param path - API path (e.g. "/api/v1/emails")
 * @param params - Query parameters
 * @returns Parsed JSON response
 */
async function unipileRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  const url = new URL(`${dsn}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: { "X-API-KEY": apiKey!, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unipile ${method} ${path} failed (HTTP ${res.status}): ${body}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Finds an email by subject via the Unipile API without folder filter.
 * Bypasses the slow inbox listing sync delay for Gmail Unipile.
 * @param accountId - Unipile account ID
 * @param subject - Subject substring to match
 * @returns The email's provider_id
 */
async function findEmailBySubjectUnipile(accountId: string, subject: string): Promise<string> {
  const MAX_RETRIES = 12;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const data = await unipileRequest("GET", "/api/v1/emails", {
      account_id: accountId,
      limit: "50",
    });
    const items = (data.items ?? []) as Array<Record<string, unknown>>;
    for (const item of items) {
      if (typeof item.subject === "string" && item.subject.includes(subject)) {
        return String(item.provider_id ?? item.id);
      }
    }
    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(
    `Could not find email with subject containing "${subject}" via Unipile API after ${MAX_RETRIES} attempts`,
  );
}

/**
 * Fetches the folders array for a single Unipile email.
 * @param emailId - The Unipile email ID (provider_id)
 * @param accountId - Unipile account ID
 * @returns List of folder names (e.g. ["INBOX", "SENT"])
 */
async function getUnipileEmailFolders(emailId: string, accountId: string): Promise<string[]> {
  const data = await unipileRequest("GET", `/api/v1/emails/${emailId}`, {
    account_id: accountId,
  });
  return (data.folders ?? []) as string[];
}

/**
 * Polls until the email has "INBOX" in its folders array (undo verification).
 * @param emailId - The Unipile email ID (provider_id)
 * @param accountId - Unipile account ID
 */
async function verifyUndoRestoredToInbox(emailId: string, accountId: string): Promise<void> {
  const MAX_RETRIES = 12;
  const RETRY_WAIT_MS = 5_000;
  let folders: string[] = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    folders = await getUnipileEmailFolders(emailId, accountId);
    if (folders.includes("INBOX")) return;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(
    `Email ${emailId} does not have INBOX in its folders after ${MAX_RETRIES} attempts. Folders: ${JSON.stringify(folders)}`,
  );
}

/**
 * Polls until the email no longer has "INBOX" in its folders array.
 * @param emailId - The Unipile email ID (provider_id)
 * @param accountId - Unipile account ID
 */
async function waitUntilGoneFromInboxUnipile(emailId: string, accountId: string): Promise<void> {
  const MAX_RETRIES = 6;
  const RETRY_WAIT_MS = 5_000;
  let folders: string[] = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    folders = await getUnipileEmailFolders(emailId, accountId);
    if (!folders.includes("INBOX")) return;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(
    `Email ${emailId} still has INBOX in folders after ${MAX_RETRIES} attempts. Folders: ${JSON.stringify(folders)}`,
  );
}
