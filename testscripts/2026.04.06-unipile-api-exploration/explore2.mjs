/**
 * Follow-up probes for corrected formats discovered in round 1.
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
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }

    const result = { status: res.status, body: data };
    const filename = `${label.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
    writeFileSync(resolve(outputDir, filename), JSON.stringify(result, null, 2));
    console.log(`Status: ${res.status}`);
    if (typeof data === "object") console.log(`Keys: ${Object.keys(data).join(", ")}`);
    if (res.status >= 400) console.log(`Error: ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return { ok: false, data: null };
  }
}

async function run() {
  const ACCOUNT_ID = "WsiwfGOgQiy_sS1te2G97Q";

  // 1. Hosted auth with CORRECT format: expiresOn (camelCase) + .000Z pattern
  const expiresOn = new Date(Date.now() + 3600000).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
  console.log(`expiresOn: ${expiresOn}`);

  await probe("20_hosted_auth_correct", "POST", "/api/v1/hosted/accounts/link", {
    type: "create",
    providers: ["GOOGLE"],
    api_url: DSN,
    expiresOn: expiresOn,
    name: "test_probe",
    notify_url: "https://example.com/notify",
  });

  // 2. Get a real email ID for mutation tests
  const emails = await probe("21_list_for_id", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&limit=1`);
  const emailId = emails.data?.items?.[0]?.id;
  console.log(`Email ID for tests: ${emailId}`);

  if (!emailId) {
    console.log("No emails found, skipping mutation probes");
    return;
  }

  // 3. PUT update email - try marking as read
  await probe("22_update_read", "PUT", `/api/v1/emails/${emailId}`, {
    unread: false,
  });

  // 4. PUT update email - try moving to folder (archive)
  // Don't actually do this, just test the format with a non-existent folder to see error shape
  await probe("23_update_move_probe", "PUT", `/api/v1/emails/${emailId}`, {
    folders: { destination: "NONEXISTENT_FOLDER_PROBE", source: "INBOX" },
  });

  // 5. POST send email - probe format (send to self to test, but with dry_run if available)
  // Actually, let's just check what the endpoint schema expects by sending minimal
  await probe("24_send_email_minimal", "POST", "/api/v1/emails", {
    account_id: ACCOUNT_ID,
    subject: "Unipile API test probe",
    body: "Test body",
    to: [{ display_name: "Test", identifier: "test-probe-do-not-deliver@example.invalid" }],
  });

  // 6. POST reply - try using reply_to field in POST /api/v1/emails
  await probe("25_reply_via_post", "POST", "/api/v1/emails", {
    account_id: ACCOUNT_ID,
    subject: "Re: test",
    body: "Reply test body",
    to: [{ display_name: "Test", identifier: "test-probe-do-not-deliver@example.invalid" }],
    reply_to: emailId,
  });

  // 7. Drafts - try POST /api/v1/emails with draft flag
  await probe("26_draft_via_flag", "POST", "/api/v1/emails", {
    account_id: ACCOUNT_ID,
    subject: "Draft probe",
    body: "Draft body",
    to: [{ display_name: "Test", identifier: "test-probe@example.invalid" }],
    draft: true,
  });

  // 8. List emails with folder filter
  await probe("27_list_sent", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&role=SENT&limit=2`);

  // 9. List emails with folder_id (get a folder ID first)
  const folders = await probe("28_list_folders", "GET", `/api/v1/folders?account_id=${ACCOUNT_ID}`);
  const folderItems = folders.data?.items ?? [];
  const sentFolder = folderItems.find(f => f.role === "SENT" || f.name?.includes("Sent"));
  if (sentFolder) {
    console.log(`Sent folder: ${JSON.stringify(sentFolder)}`);
    await probe("29_list_by_folder", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&folder=${sentFolder.id}&limit=2`);
  }

  // 10. Thread - emails have thread_id, can we filter by it?
  const threadId = emails.data?.items?.[0]?.thread_id;
  if (threadId) {
    console.log(`Thread ID: ${threadId}`);
    await probe("30_list_by_thread", "GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&thread_id=${threadId}`);
  }

  console.log("\n=== ROUND 2 COMPLETE ===");
}

run().catch(console.error);
