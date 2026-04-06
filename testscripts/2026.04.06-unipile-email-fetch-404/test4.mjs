/**
 * Test 4: Verify that provider_id + account_id works for individual email fetch.
 * This is the working approach for accounts where the Unipile `id` returns 404.
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });

const DSN = process.env.UNIPILE_DSN;
const API_KEY = process.env.UNIPILE_API_KEY;
const ACCOUNT_ID = process.env.UNIPILE_ACCOUNT_ID;

async function apiGet(path) {
  const res = await fetch(`${DSN}${path}`, {
    method: "GET",
    headers: { "X-API-KEY": API_KEY, "Accept": "application/json" },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  // List emails
  const listRes = await apiGet(`/api/v1/emails?account_id=${ACCOUNT_ID}&limit=5&folder=INBOX`);
  const emails = listRes.json?.items ?? [];
  console.log(`Listed ${emails.length} emails\n`);

  for (const e of emails) {
    console.log(`subject: "${e.subject?.substring(0, 60)}"`);
    console.log(`  id: ${e.id} | provider_id: ${e.provider_id}`);

    // Fetch by provider_id + account_id
    const res = await apiGet(`/api/v1/emails/${e.provider_id}?account_id=${ACCOUNT_ID}`);
    if (res.ok) {
      const from = res.json.from_attendee?.identifier ?? "unknown";
      console.log(`  FETCH OK -> from=${from}, subject="${res.json.subject?.substring(0, 60)}"`);
    } else {
      console.log(`  FETCH FAILED -> ${res.status}`);
    }
    console.log();
  }
}

main().catch(console.error);
