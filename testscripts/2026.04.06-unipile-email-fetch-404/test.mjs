/**
 * Test: Why do Unipile email IDs from the list endpoint return 404
 * when fetched individually via GET /api/v1/emails/{id}?
 *
 * The Python voice pipeline client can read emails fine, but the TS
 * client's fetchEmailMetaBatch gets 404 on the same IDs.
 *
 * Tests:
 * 1. List emails, grab IDs, fetch each individually
 * 2. Try with and without account_id query param
 * 3. Try provider_id instead of id
 * 4. Compare different accounts (old vs new)
 * 5. Check if URL encoding of the ID matters
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

async function apiGet(path) {
  const url = `${DSN}${path}`;
  console.log(`  GET ${path}`);
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-API-KEY": API_KEY, "Accept": "application/json" },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status: res.status, ok: res.ok, body, json };
}

function printResult(label, result) {
  if (result.ok) {
    const subject = result.json?.subject ?? "(no subject field)";
    const id = result.json?.id ?? "(no id)";
    console.log(`  [OK ${result.status}] ${label} -- id=${id}, subject="${subject}"`);
  } else {
    console.log(`  [FAIL ${result.status}] ${label} -- ${result.body.substring(0, 120)}`);
  }
}

// ============================================================================
// TESTS
// ============================================================================

async function main() {
  console.log("=== Test 1: List accounts ===");
  const acctRes = await apiGet("/api/v1/accounts");
  const accounts = acctRes.json?.items ?? [];
  console.log(`Found ${accounts.length} accounts:`);
  for (const a of accounts) {
    const email = a.connection_params?.mail?.id ?? a.name;
    console.log(`  ${a.id} | ${email} | ${a.type} | created ${a.created_at}`);
  }

  console.log(`\n=== Test 2: List emails from target account (${ACCOUNT_ID}) ===`);
  const listRes = await apiGet(`/api/v1/emails?account_id=${ACCOUNT_ID}&limit=5&folder=INBOX`);
  const emails = listRes.json?.items ?? [];
  console.log(`Listed ${emails.length} emails:`);
  for (const e of emails) {
    console.log(`  id=${e.id} | provider_id=${e.provider_id} | subject="${e.subject?.substring(0, 50)}"`);
  }

  if (emails.length === 0) {
    console.log("No emails found, cannot proceed.");
    return;
  }

  console.log("\n=== Test 3: Fetch each listed email by its 'id' field ===");
  for (const e of emails) {
    const result = await apiGet(`/api/v1/emails/${e.id}`);
    printResult(`id=${e.id}`, result);
  }

  console.log("\n=== Test 4: Fetch with account_id query param ===");
  for (const e of emails.slice(0, 2)) {
    const result = await apiGet(`/api/v1/emails/${e.id}?account_id=${ACCOUNT_ID}`);
    printResult(`id=${e.id} + account_id`, result);
  }

  console.log("\n=== Test 5: Fetch by provider_id (requires account_id) ===");
  for (const e of emails.slice(0, 2)) {
    const result = await apiGet(`/api/v1/emails/${e.provider_id}?account_id=${ACCOUNT_ID}`);
    printResult(`provider_id=${e.provider_id} + account_id`, result);
  }

  console.log("\n=== Test 6: Fetch with URL-encoded id ===");
  for (const e of emails.slice(0, 2)) {
    const encoded = encodeURIComponent(e.id);
    const result = await apiGet(`/api/v1/emails/${encoded}`);
    printResult(`encoded id=${encoded}`, result);
  }

  // Test with the older working account for comparison
  const olderAccount = accounts.find(a =>
    a.connection_params?.mail?.id === "arthur.stockman.me@gmail.com"
    && a.created_at < "2026-04-06T18:00:00"
  );
  if (olderAccount) {
    console.log(`\n=== Test 7: Compare with older account ${olderAccount.id} ===`);
    const oldListRes = await apiGet(`/api/v1/emails?account_id=${olderAccount.id}&limit=3&folder=INBOX`);
    const oldEmails = oldListRes.json?.items ?? [];
    console.log(`Listed ${oldEmails.length} emails from old account:`);
    for (const e of oldEmails) {
      console.log(`  id=${e.id} | provider_id=${e.provider_id}`);
    }

    console.log("Fetching individually:");
    for (const e of oldEmails.slice(0, 2)) {
      const result = await apiGet(`/api/v1/emails/${e.id}`);
      printResult(`old account id=${e.id}`, result);
    }
  }

  // Check account sources/sync status
  console.log(`\n=== Test 8: Account sync status ===`);
  const targetAcct = await apiGet(`/api/v1/accounts/${ACCOUNT_ID}`);
  if (targetAcct.ok) {
    const sources = targetAcct.json.sources ?? [];
    console.log(`  Target account sources:`, JSON.stringify(sources, null, 2));
  }
  if (olderAccount) {
    const oldAcct = await apiGet(`/api/v1/accounts/${olderAccount.id}`);
    if (oldAcct.ok) {
      const sources = oldAcct.json.sources ?? [];
      console.log(`  Older account sources:`, JSON.stringify(sources, null, 2));
    }
  }

  // Check the full email object shape from list to see if there's something we're missing
  console.log("\n=== Test 9: Full email object from list (first email) ===");
  if (emails.length > 0) {
    const keys = Object.keys(emails[0]);
    console.log(`  Fields: ${keys.join(", ")}`);
    console.log(`  id type: ${typeof emails[0].id}, value: "${emails[0].id}"`);
    console.log(`  provider_id type: ${typeof emails[0].provider_id}, value: "${emails[0].provider_id}"`);
    console.log(`  kind: ${emails[0].kind}`);
    console.log(`  is_complete: ${emails[0].is_complete}`);
    console.log(`  account_id in email: ${emails[0].account_id}`);
  }
}

main().catch(console.error);
