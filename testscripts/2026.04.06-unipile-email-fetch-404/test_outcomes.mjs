/**
 * Outcome tests for Unipile email operations.
 *
 * Tests the actual email workflows that our app performs:
 * 1. List inbox emails
 * 2. Fetch individual email details (used by read_email, fetchEmailMetaBatch)
 * 3. Fetch email metadata for enrichment (subject + from for end-of-session)
 *
 * These tests hit the real Unipile API. They should pass for any valid account.
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const DSN = process.env.UNIPILE_DSN;
const API_KEY = process.env.UNIPILE_API_KEY;
const ACCOUNT_ID = process.env.UNIPILE_ACCOUNT_ID;

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.log(`  FAIL: ${message}`);
    failed++;
  }
}

async function apiGet(path) {
  const res = await fetch(`${DSN}${path}`, {
    method: "GET",
    headers: { "X-API-KEY": API_KEY, "Accept": "application/json" },
  });
  const json = res.ok ? await res.json() : null;
  return { status: res.status, ok: res.ok, json };
}

// ============================================================================
// TESTS
// ============================================================================

async function main() {
  // --- List inbox ---
  console.log("\n[1] List inbox emails");
  const listRes = await apiGet(`/api/v1/emails?account_id=${ACCOUNT_ID}&limit=5&folder=INBOX`);
  assert(listRes.ok, "list inbox returns 200");
  const emails = listRes.json?.items ?? [];
  assert(emails.length > 0, "inbox has at least one email");

  const firstEmail = emails[0];
  assert(typeof firstEmail.id === "string" && firstEmail.id.length > 0, "email has id");
  assert(typeof firstEmail.provider_id === "string" && firstEmail.provider_id.length > 0, "email has provider_id");
  assert(typeof firstEmail.subject === "string", "email has subject");
  assert(firstEmail.from_attendee?.identifier, "email has from_attendee.identifier");

  // --- Fetch individual email (simulates read_email + fetchEmailMetaBatch) ---
  console.log("\n[2] Fetch individual email by provider_id + account_id");
  for (const e of emails.slice(0, 3)) {
    const res = await apiGet(`/api/v1/emails/${e.provider_id}?account_id=${ACCOUNT_ID}`);
    assert(res.ok, `fetch email provider_id=${e.provider_id} returns 200`);
    if (res.ok) {
      assert(res.json.subject === e.subject, `fetched subject matches listed subject`);
      assert(res.json.from_attendee?.identifier === e.from_attendee?.identifier, `fetched from matches listed from`);
    }
  }

  // --- Fetch email metadata for end-of-session enrichment ---
  console.log("\n[3] Fetch email metadata (subject + from) for enrichment");
  for (const e of emails.slice(0, 3)) {
    const res = await apiGet(`/api/v1/emails/${e.provider_id}?account_id=${ACCOUNT_ID}`);
    assert(res.ok, `metadata fetch for provider_id=${e.provider_id} returns 200`);
    if (res.ok) {
      const subject = res.json.subject ?? null;
      const from = res.json.from_attendee?.identifier ?? null;
      assert(subject !== null, `metadata has subject: "${subject?.substring(0, 40)}"`);
      assert(from !== null, `metadata has from: "${from}"`);
    }
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
