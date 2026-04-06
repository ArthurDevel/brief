/**
 * Test 2: Compare ID behavior across accounts and check deprecated_id field.
 *
 * From test.mjs we learned:
 * - GET /api/v1/emails/{id} returns 404 for account hvrrj_AQQJCQhLzJp2Eq2g
 * - GET /api/v1/emails/{provider_id}?account_id=X returns 200
 * - There's a "deprecated_id" field in the list response
 *
 * Now test:
 * 1. Do older accounts also 404 when fetching by id?
 * 2. What is the deprecated_id value? Does fetching by deprecated_id work?
 * 3. Does the Python client actually use the same account or a different one?
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const DSN = process.env.UNIPILE_DSN;
const API_KEY = process.env.UNIPILE_API_KEY;

async function apiGet(path) {
  const url = `${DSN}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-API-KEY": API_KEY, "Accept": "application/json" },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  // Get all accounts
  const acctRes = await apiGet("/api/v1/accounts");
  const accounts = acctRes.json?.items ?? [];

  // Test each account
  for (const acct of accounts) {
    const email = acct.connection_params?.mail?.id ?? acct.name;
    console.log(`\n=== Account: ${acct.id} (${email}) | created: ${acct.created_at} ===`);

    const listRes = await apiGet(`/api/v1/emails?account_id=${acct.id}&limit=2&folder=INBOX`);
    const emails = listRes.json?.items ?? [];

    if (emails.length === 0) {
      console.log("  No emails found");
      continue;
    }

    for (const e of emails.slice(0, 1)) {
      console.log(`  email id="${e.id}" | provider_id="${e.provider_id}" | deprecated_id="${e.deprecated_id}"`);

      // Test 1: Fetch by id (no account_id)
      const r1 = await apiGet(`/api/v1/emails/${e.id}`);
      console.log(`    GET /emails/${e.id} -> ${r1.status}`);

      // Test 2: Fetch by deprecated_id (if it exists)
      if (e.deprecated_id) {
        const r2 = await apiGet(`/api/v1/emails/${e.deprecated_id}`);
        console.log(`    GET /emails/${e.deprecated_id} (deprecated_id) -> ${r2.status}`);
      }

      // Test 3: Fetch by provider_id + account_id
      const r3 = await apiGet(`/api/v1/emails/${e.provider_id}?account_id=${acct.id}`);
      console.log(`    GET /emails/${e.provider_id}?account_id=${acct.id} -> ${r3.status}`);

      // Test 4: Fetch by id + account_id
      const r4 = await apiGet(`/api/v1/emails/${e.id}?account_id=${acct.id}`);
      console.log(`    GET /emails/${e.id}?account_id=${acct.id} -> ${r4.status}`);
    }
  }

  // Also check: what does the DB have stored for the last session's actions?
  console.log("\n=== Checking what IDs the voice pipeline stored ===");
  console.log("(Check the actions table for email_id values in the arguments column)");
}

main().catch(console.error);
