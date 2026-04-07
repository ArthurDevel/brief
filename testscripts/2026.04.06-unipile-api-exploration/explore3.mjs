/**
 * Round 3: test reply format, folder move format, and delete draft.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, ".env");
const envContent = readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
}

const DSN = env.UNIPILE_DSN;
const API_KEY = env.UNIPILE_API_KEY;
const outputDir = resolve(__dirname, "output");
mkdirSync(outputDir, { recursive: true });

async function probe(label, method, path, body = null) {
  const url = `${DSN}${path}`;
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${url}`);
  const headers = { "X-API-KEY": API_KEY, "accept": "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    writeFileSync(resolve(outputDir, `${label.replace(/[^a-zA-Z0-9]/g, "_")}.json`), JSON.stringify({ status: res.status, body: data }, null, 2));
    console.log(`Status: ${res.status}`);
    if (res.status >= 400) console.log(`Error: ${JSON.stringify(data).slice(0, 500)}`);
    else if (typeof data === "object") console.log(`Keys: ${Object.keys(data).join(", ")}`);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return { ok: false, data: null };
  }
}

async function run() {
  const ACCOUNT_ID = "WsiwfGOgQiy_sS1te2G97Q";

  // Get a real email to reply to
  const emails = await probe("40_get_email_for_reply", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&limit=1`);
  const email = emails.data?.items?.[0];
  if (!email) { console.log("No emails"); return; }
  console.log(`Email subject: ${email.subject}`);
  console.log(`Email ID: ${email.id}`);
  console.log(`Email provider_id: ${email.provider_id}`);

  // 1. Reply with proper Re: subject
  await probe("41_reply_correct_subject", "POST", "/api/v1/emails", {
    account_id: ACCOUNT_ID,
    subject: `Re: ${email.subject}`,
    body: "Test reply body - ignore this",
    to: [{ display_name: email.from_attendee.display_name, identifier: email.from_attendee.identifier }],
    reply_to: email.provider_id,  // Use provider_id instead of Unipile ID
  });

  // 2. Reply using Unipile email ID instead of provider_id
  await probe("42_reply_unipile_id", "POST", "/api/v1/emails", {
    account_id: ACCOUNT_ID,
    subject: `Re: ${email.subject}`,
    body: "Test reply body 2 - ignore this",
    to: [{ display_name: email.from_attendee.display_name, identifier: email.from_attendee.identifier }],
    reply_to: email.id,
  });

  // 3. Move email - folders is an array of strings (from error message)
  await probe("43_move_to_folder_array", "PUT", `/api/v1/emails/${email.id}`, {
    folders: ["INBOX"],  // Try moving to INBOX (no-op since likely already there)
  });

  // 4. Get the actual email to check current folders
  console.log(`\nEmail folders: ${JSON.stringify(email.folders)}`);
  console.log(`Email folderIds: ${JSON.stringify(email.folderIds)}`);

  // 5. Try listing emails filtered by from address (for contact extraction / newsletter)
  await probe("44_list_by_from", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&from=${encodeURIComponent(email.from_attendee.identifier)}&limit=2`);

  // 6. Try listing with after parameter (date filter)
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  await probe("45_list_after_date", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&after=${encodeURIComponent(yesterday)}&limit=2`);

  // 7. Check what fields the account object has (for email extraction)
  const account = await probe("46_get_account_detail", "GET", `/api/v1/accounts/${ACCOUNT_ID}`);
  if (account.ok) {
    console.log(`\nAccount full: ${JSON.stringify(account.data, null, 2).slice(0, 600)}`);
  }

  // 8. Check if there's a dedicated reply endpoint we missed
  await probe("47_reply_endpoint", "POST", `/api/v1/emails/${email.id}/reply`, {
    body: "Test",
  });

  console.log("\n=== ROUND 3 COMPLETE ===");
}

run().catch(console.error);
