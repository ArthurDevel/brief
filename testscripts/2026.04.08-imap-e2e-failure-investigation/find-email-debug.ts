/**
 * Debug why findEmailBySubject takes ~15s per email during re-seeding.
 * Tests whether listInbox(50) actually returns the most recent emails
 * and whether the e2e-tagged emails are findable.
 *
 * Usage: npx tsx find-email-debug.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, ".env") });
config({ path: resolve(import.meta.dirname, "../../.env.test.local") });

const TAG = "[e2e-ts]";

async function main() {
  const { createEmailAccountClient } = await import("../../packages/email/src/account-client");

  const record = {
    id: "test-gmail-imap",
    userId: "test-user",
    provider: "gmail" as const,
    connectionType: "imap_smtp" as const,
    emailAddress: process.env.TEST_GMAIL_IMAP_EMAIL!,
    unipileAccountId: null,
    status: "active",
    lastError: null,
    customConfig: {
      imap: {
        host: process.env.TEST_GMAIL_IMAP_HOST!,
        port: Number(process.env.TEST_GMAIL_IMAP_PORT!),
        user: process.env.TEST_GMAIL_IMAP_USER!,
        password: process.env.TEST_GMAIL_IMAP_PASSWORD!,
      },
      smtp: {
        host: process.env.TEST_GMAIL_SMTP_HOST!,
        port: Number(process.env.TEST_GMAIL_SMTP_PORT!),
        user: process.env.TEST_GMAIL_SMTP_USER!,
        password: process.env.TEST_GMAIL_SMTP_PASSWORD!,
      },
    },
  };

  const client = await createEmailAccountClient(record);
  console.log("Client created\n");

  // Test 1: What does listInbox(50) return?
  console.log("=== listInbox(50) ===");
  let t0 = Date.now();
  const inbox50 = await client.listInbox(50);
  console.log(`Returned ${inbox50.length} emails in ${Date.now() - t0}ms`);
  console.log("Most recent 5:");
  for (const e of inbox50.slice(0, 5)) {
    console.log(`  UID=${e.id} "${e.subject}" (${e.date})`);
  }
  const taggedInInbox = inbox50.filter((e) => e.subject.includes(TAG));
  console.log(`\nE2e-tagged in top 50: ${taggedInInbox.length}`);
  for (const e of taggedInInbox.slice(0, 5)) {
    console.log(`  UID=${e.id} "${e.subject}"`);
  }

  // Test 2: How long does listInbox take for various limits?
  console.log("\n=== listInbox timing for various limits ===");
  for (const limit of [10, 20, 50, 100]) {
    t0 = Date.now();
    const results = await client.listInbox(limit);
    console.log(`listInbox(${limit}): ${results.length} emails in ${Date.now() - t0}ms`);
  }

  // Test 3: searchEmails for a specific pool subject
  console.log("\n=== searchEmails for pool subjects ===");
  for (const subject of [`${TAG} Seed email`, `${TAG} Pool deleteRecipe`]) {
    t0 = Date.now();
    const results = await client.searchEmails(subject);
    console.log(`searchEmails("${subject}"): ${results.length} results in ${Date.now() - t0}ms`);
    if (results.length > 0) {
      console.log(`  First: UID=${results[0].id} "${results[0].subject}"`);
    }
  }

  // Test 4: Send one email and time how long until it appears in listInbox
  console.log("\n=== Send + find timing test ===");
  const testSubject = `${TAG} timing-test-${Date.now()}`;
  t0 = Date.now();
  await client.sendEmail({
    to: record.emailAddress!,
    subject: testSubject,
    body: "Timing test",
  });
  console.log(`Sent in ${Date.now() - t0}ms`);

  // Poll listInbox until found
  const pollStart = Date.now();
  for (let i = 0; i < 20; i++) {
    const pt0 = Date.now();
    const emails = await client.listInbox(50);
    const dur = Date.now() - pt0;
    const found = emails.find((e) => e.subject.includes(testSubject));
    if (found) {
      console.log(`Found after ${Date.now() - pollStart}ms (attempt ${i + 1}, listInbox took ${dur}ms)`);
      break;
    }
    console.log(`Attempt ${i + 1}: not found (listInbox: ${dur}ms, top subject: "${emails[0]?.subject}")`);
    await new Promise((r) => setTimeout(r, 2_000));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
