/**
 * E2E tests for EmailAccountClient across all 4 provider/connection combos.
 *
 * Tests actual outcomes through the highest-level API (createEmailAccountClient).
 * Each account sends only to itself. Each test run seeds its own data using a
 * unique run ID to avoid collisions.
 *
 * Responsibilities:
 * - Seed each account with test emails before running assertions
 * - Verify all EmailAccountClient operations produce correct results
 * - Run the same test suite against Gmail/Outlook x Unipile/IMAP
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createEmailAccountClient } from "../../account-client";
import type { EmailAccountClient } from "../../types";
import { loadTestAccounts, TEST_RUN_ID } from "./accounts";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Subject prefix to identify seeded emails from this run */
const TAG = `[${TEST_RUN_ID}]`;

/** How long to wait for email delivery before asserting (ms) */
const DELIVERY_WAIT_MS = 15_000;

/** Subjects for seeded emails */
const SEED_SUBJECT = `${TAG} Seed email`;
const THREAD_SUBJECT = `${TAG} Thread test`;
const SEARCH_SUBJECT = `${TAG} Searchable uniquetoken`;

// ============================================================================
// TEST SUITE
// ============================================================================

const accounts = loadTestAccounts();

describe.each(accounts)("EmailAccountClient -- $label", ({ record, emailAddress }) => {
  let client: EmailAccountClient;

  // IDs captured during seeding, used by later tests
  let seedEmailId: string;
  let threadEmailId: string;

  // ------------------------------------------------------------------
  // SETUP: create client and seed test data
  // ------------------------------------------------------------------

  beforeAll(async () => {
    client = await createEmailAccountClient(record);

    // Seed 3 emails to self:
    // 1. A basic email (used by readEmail, markAsRead, archive, move tests)
    // 2. A thread starter (used by readThread, fetchReplyContext, replyEmail)
    // 3. A searchable email (used by searchEmails)
    await client.sendEmail({ to: emailAddress, subject: SEED_SUBJECT, body: `Seed body for ${TEST_RUN_ID}` });
    await client.sendEmail({ to: emailAddress, subject: THREAD_SUBJECT, body: `Thread starter for ${TEST_RUN_ID}` });
    await client.sendEmail({ to: emailAddress, subject: SEARCH_SUBJECT, body: `Search body for ${TEST_RUN_ID}` });

    // Wait for delivery
    await wait(DELIVERY_WAIT_MS);

    // Find the seeded emails in inbox
    seedEmailId = await findEmailBySubject(client, SEED_SUBJECT);
    threadEmailId = await findEmailBySubject(client, THREAD_SUBJECT);
  }, 120_000);

  // ------------------------------------------------------------------
  // INBOX & SEARCH
  // ------------------------------------------------------------------

  it("listInbox returns EmailSummary[] with required fields", async () => {
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
    const emails = await client.listInbox(50);
    const found = emails.find((e) => e.subject.includes(TAG));
    expect(found).toBeDefined();
  });

  it("searchEmails finds the searchable email", async () => {
    const results = await client.searchEmails("uniquetoken");
    const found = results.find((e) => e.subject.includes(SEARCH_SUBJECT));
    expect(found).toBeDefined();
  });

  // ------------------------------------------------------------------
  // READ
  // ------------------------------------------------------------------

  it("readEmail returns full Email with body", async () => {
    const email = await client.readEmail(seedEmailId);

    expect(email.id).toBeTruthy();
    expect(email.subject).toContain(SEED_SUBJECT);
    expect(email.body).toContain(TEST_RUN_ID);
    expect(email.from).toBeTruthy();
    expect(email.to).toBeTruthy();
    expect(email.date).toBeTruthy();
    expect(typeof email.isRead).toBe("boolean");
  });

  // ------------------------------------------------------------------
  // THREAD
  // ------------------------------------------------------------------

  it("readThread returns at least the thread starter", async () => {
    const messages = await client.readThread(threadEmailId);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const starter = messages.find((m) => m.subject.includes(THREAD_SUBJECT));
    expect(starter).toBeDefined();
    expect(starter!.body).toContain(TEST_RUN_ID);
  });

  // ------------------------------------------------------------------
  // MARK AS READ
  // ------------------------------------------------------------------

  it("markAsRead marks the email as read", async () => {
    await client.markAsRead(seedEmailId);
    const email = await client.readEmail(seedEmailId);
    expect(email.isRead).toBe(true);
  });

  // ------------------------------------------------------------------
  // FOLDERS
  // ------------------------------------------------------------------

  it("listFolders returns FolderInfo[] with at least one folder", async () => {
    const folders = await client.listFolders();

    expect(folders.length).toBeGreaterThan(0);
    const folder = folders[0];
    expect(folder).toHaveProperty("path");
    expect(folder).toHaveProperty("name");
    expect(folder).toHaveProperty("specialUse");
  });

  it("resolveSpecialUseFolder finds Trash", async () => {
    const trash = await client.resolveSpecialUseFolder("\\Trash");
    expect(trash).toBeTruthy();
  });

  it("resolveSpecialUseFolder finds Drafts", async () => {
    const drafts = await client.resolveSpecialUseFolder("\\Drafts");
    expect(drafts).toBeTruthy();
  });

  it("resolveSpecialUseFolder finds Sent", async () => {
    const sent = await client.resolveSpecialUseFolder("\\Sent");
    expect(sent).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // DRAFT LIFECYCLE
  // ------------------------------------------------------------------

  it("saveDraft creates a draft, deleteDraft removes it", async () => {
    const undoRecipe = await client.saveDraft({
      to: emailAddress,
      subject: `${TAG} Draft test`,
      body: `Draft body ${TEST_RUN_ID}`,
    });

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("delete_draft");
    expect(undoRecipe!.params.draftUid).toBeTruthy();

    // deleteDraft takes a number (UID for IMAP) but Unipile IDs are strings.
    // The account-client wrapper converts via String(), so passing the raw value works.
    await client.deleteDraft(undoRecipe!.params.draftUid as unknown as number);
  });

  it("saveDraft with CC creates a draft", async () => {
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
    // Simulate converting a pending reply_email action to a draft:
    // fetch reply context, then save as draft with inReplyTo + references
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
    const subject = `${TAG} Send test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Send test body" });

    await wait(DELIVERY_WAIT_MS);

    const results = await client.searchEmails(subject);
    const found = results.find((e) => e.subject.includes(subject));
    expect(found).toBeDefined();
  });

  it("fetchReplyContext returns valid context", async () => {
    const ctx = await client.fetchReplyContext(threadEmailId);

    expect(ctx.messageId).toBeTruthy();
    expect(ctx.subject).toContain(THREAD_SUBJECT);
    expect(ctx.from).toBeTruthy();
    expect(Array.isArray(ctx.to)).toBe(true);
    expect(Array.isArray(ctx.cc)).toBe(true);
    expect(Array.isArray(ctx.references)).toBe(true);
  });

  it("replyEmail sends a threaded reply to self", async () => {
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
    // For IMAP, fetchEmailMetaBatch needs a UID (via uid field) or an RFC Message-ID
    // (via messageId field). Use uid for broadest compatibility.
    const results = await client.fetchEmailMetaBatch([
      { actionId: "test-1", uid: seedEmailId },
    ]);

    expect(results.size).toBe(1);
    const meta = results.get("test-1");
    expect(meta).toBeDefined();
    expect(meta!.subject).toContain(SEED_SUBJECT);
    expect(meta!.from).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // DELETE
  // ------------------------------------------------------------------

  it("deleteEmail moves to trash and returns undo recipe", async () => {
    const subject = `${TAG} Delete test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Delete test body" });
    await wait(DELIVERY_WAIT_MS);

    const deleteEmailId = await findEmailBySubject(client, subject);
    const undoRecipe = await client.deleteEmail(deleteEmailId, "INBOX");

    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");
    // IMAP returns real folder path (e.g. "[Gmail]/Trash"), Unipile returns "TRASH"
    expect(undoRecipe!.params.from).toBeTruthy();
    expect(undoRecipe!.params.to).toBe("INBOX");
  });

  // ------------------------------------------------------------------
  // ARCHIVE + UNDO
  // ------------------------------------------------------------------

  it("archiveEmail removes from inbox, undo moves it back", async () => {
    const subject = `${TAG} Archive undo test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Archive undo test body" });
    await wait(DELIVERY_WAIT_MS);

    const emailId = await findEmailBySubject(client, subject);

    // Archive it
    const undoRecipe = await client.archiveEmail(emailId, "INBOX");
    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");

    // Verify it left the inbox (retry-based to handle eventual consistency)
    await waitUntilGoneFromInbox(client, subject);

    // Undo: move it back to INBOX (IMAP uses messageId, Unipile uses emailId)
    const { from, to } = undoRecipe!.params as Record<string, string>;
    const identifier = undoRecipe!.params.emailId ?? undoRecipe!.params.messageId;
    await client.moveEmail(identifier as string, to, from);

    // Verify it is back in inbox
    const found = await findEmailBySubject(client, subject);
    expect(found).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // DELETE + UNDO
  // ------------------------------------------------------------------

  it("deleteEmail moves to trash, undo moves it back to inbox", async () => {
    const subject = `${TAG} Delete undo test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Delete undo test body" });
    await wait(DELIVERY_WAIT_MS);

    const emailId = await findEmailBySubject(client, subject);

    // Delete it
    const undoRecipe = await client.deleteEmail(emailId, "INBOX");
    expect(undoRecipe).toBeTruthy();

    // Verify it left the inbox
    await waitUntilGoneFromInbox(client, subject);

    // Undo: move it back (IMAP uses messageId, Unipile uses emailId)
    const { from, to } = undoRecipe!.params as Record<string, string>;
    const identifier = undoRecipe!.params.emailId ?? undoRecipe!.params.messageId;
    await client.moveEmail(identifier as string, to, from);

    // Verify it is back
    const found = await findEmailBySubject(client, subject);
    expect(found).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // MOVE TO FOLDER + UNDO
  // ------------------------------------------------------------------

  it("moveToFolder moves email, undo moves it back", async () => {
    const subject = `${TAG} Move undo test ${Date.now()}`;
    await client.sendEmail({ to: emailAddress, subject, body: "Move undo test body" });
    await wait(DELIVERY_WAIT_MS);

    const emailId = await findEmailBySubject(client, subject);
    const trash = await client.resolveSpecialUseFolder("\\Trash");
    expect(trash).toBeTruthy();

    // Move to trash
    const undoRecipe = await client.moveToFolder(emailId, trash!, "INBOX");
    expect(undoRecipe).toBeTruthy();
    expect(undoRecipe!.operation).toBe("move_email");

    // Verify it left inbox
    await waitUntilGoneFromInbox(client, subject);

    // Undo: move it back (IMAP uses messageId, Unipile uses emailId)
    const { from, to } = undoRecipe!.params as Record<string, string>;
    const identifier = undoRecipe!.params.emailId ?? undoRecipe!.params.messageId;
    await client.moveEmail(identifier as string, to, from);

    // Verify it is back
    const found = await findEmailBySubject(client, subject);
    expect(found).toBeTruthy();
  });
});

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
 * Searches inbox for an email matching the given subject.
 * Retries up to 6 times (total ~30s) to handle delivery delay and eventual consistency.
 * @param client - The email client
 * @param subject - Subject string to match
 * @returns The email ID
 */
async function findEmailBySubject(client: EmailAccountClient, subject: string): Promise<string> {
  const MAX_RETRIES = 6;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const emails = await client.listInbox(50);
    const found = emails.find((e) => e.subject.includes(subject));
    if (found) return found.id;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(`Could not find email with subject containing "${subject}" after ${MAX_RETRIES} attempts`);
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
 * Waits until an email with the given subject is no longer in the inbox.
 * Retries up to 6 times (total ~30s) to handle eventual consistency.
 * @param client - The email client
 * @param subject - Subject string to match
 */
async function waitUntilGoneFromInbox(client: EmailAccountClient, subject: string): Promise<void> {
  const MAX_RETRIES = 6;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const emails = await client.listInbox(50);
    const found = emails.find((e) => e.subject.includes(subject));
    if (!found) return;

    if (attempt < MAX_RETRIES - 1) {
      await wait(RETRY_WAIT_MS);
    }
  }

  throw new Error(`Email with subject containing "${subject}" still in inbox after ${MAX_RETRIES} attempts`);
}
