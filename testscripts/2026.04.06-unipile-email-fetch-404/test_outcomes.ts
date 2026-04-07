/**
 * Outcome tests for Unipile email operations.
 *
 * Imports the actual TS unipile-client and tests the real code paths:
 * 1. listInbox -- list emails
 * 2. readEmail -- fetch individual email (used during voice calls)
 * 3. fetchEmailMetaBatch -- fetch metadata for end-of-session enrichment
 *
 * Run: npx tsx test_outcomes.ts
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "dotenv";

// Load env BEFORE importing the client (it reads env at module level)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const { listInbox, readEmail, fetchEmailMetaBatch } = await import(
  "../../packages/email/src/unipile-client"
);

const ACCOUNT_ID = process.env.UNIPILE_ACCOUNT_ID!;

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.log(`  FAIL: ${message}`);
    failed++;
  }
}

// ============================================================================
// TESTS
// ============================================================================

async function main() {
  // --- List inbox ---
  console.log("\n[1] listInbox");
  const emails = await listInbox(ACCOUNT_ID, 5);
  assert(emails.length > 0, "inbox has at least one email");
  assert(typeof emails[0].id === "string" && emails[0].id.length > 0, "email has id");
  assert(typeof emails[0].subject === "string", "email has subject");
  assert(typeof emails[0].from === "string" && emails[0].from.length > 0, "email has from");

  // --- Read individual email ---
  console.log("\n[2] readEmail (for each listed email)");
  for (const summary of emails.slice(0, 3)) {
    try {
      const email = await readEmail(ACCOUNT_ID, summary.id);
      assert(true, `readEmail(${summary.id}) succeeded`);
      assert(email.subject === summary.subject, `subject matches: "${email.subject.substring(0, 40)}"`);
      assert(email.from.length > 0, `has from: "${email.from}"`);
    } catch (err: any) {
      assert(false, `readEmail(${summary.id}) threw: ${err.message.substring(0, 80)}`);
    }
  }

  // --- Fetch email metadata batch (end-of-session enrichment) ---
  console.log("\n[3] fetchEmailMetaBatch");
  const requests = emails.slice(0, 3).map((e, i) => ({
    actionId: `test-action-${i}`,
    uid: e.id,
  }));
  const metaMap = await fetchEmailMetaBatch(ACCOUNT_ID, requests);
  assert(metaMap.size === requests.length, `batch returned ${metaMap.size}/${requests.length} results`);
  for (const [actionId, meta] of metaMap) {
    assert(typeof meta.subject === "string" && meta.subject.length > 0, `${actionId} has subject`);
    assert(typeof meta.from === "string" && meta.from.length > 0, `${actionId} has from`);
  }

  // --- Summary ---
  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
