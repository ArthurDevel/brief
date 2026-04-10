/**
 * Standalone investigation script for Outlook Unipile 404 on PUT /api/v1/emails/{id}.
 *
 * Tests:
 * 1. List inbox emails and inspect the ID format
 * 2. GET a single email by ID (does read work?)
 * 3. GET email by provider_id
 * 4. PUT to move email using the ID from list (reproduces the 404)
 * 5. Compare Gmail vs Outlook ID formats
 *
 * Run: node --env-file=.env investigate.mjs
 */

import { readFileSync } from "fs";

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const OUTLOOK_ACCOUNT_ID = process.env.TEST_OUTLOOK_UNIPILE_ACCOUNT_ID;
const GMAIL_ACCOUNT_ID = process.env.TEST_GMAIL_UNIPILE_ACCOUNT_ID;

if (!API_KEY || !DSN || !OUTLOOK_ACCOUNT_ID) {
  console.error("Missing required env vars. See .env.example");
  process.exit(1);
}

const headers = { "X-API-KEY": API_KEY, "Content-Type": "application/json" };

async function api(method, path, body) {
  const url = `${DSN}${path}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function log(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function investigateAccount(label, accountId) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`INVESTIGATING: ${label} (account: ${accountId})`);
  console.log("=".repeat(60));

  // Step 1: Resolve inbox folder
  const foldersRes = await api("GET", `/api/v1/folders?account_id=${accountId}`);
  const inbox = foldersRes.data.items?.find(f => f.role === "inbox");
  if (!inbox) {
    console.log("No inbox folder found!");
    return;
  }
  log("Inbox folder", inbox);

  // Step 2: List inbox emails
  const inboxProviderId = encodeURIComponent(inbox.provider_id);
  const listRes = await api("GET", `/api/v1/emails?account_id=${accountId}&limit=3&folder=${inboxProviderId}`);
  if (!listRes.ok) {
    log("List inbox FAILED", listRes);
    return;
  }

  const emails = listRes.data.items || [];
  log(`Listed ${emails.length} emails`, emails.map(e => ({
    id: e.id,
    provider_id: e.provider_id,
    subject: e.subject,
    id_type: typeof e.id,
    id_length: e.id?.length,
  })));

  if (emails.length === 0) {
    console.log("No emails to test with");
    return;
  }

  const testEmail = emails[0];
  log("Test email", { id: testEmail.id, provider_id: testEmail.provider_id, subject: testEmail.subject });

  // Step 3: GET single email by id (from list response)
  const getByIdRes = await api("GET", `/api/v1/emails/${testEmail.id}?account_id=${accountId}`);
  log(`GET /emails/${testEmail.id} (by id)`, { status: getByIdRes.status, ok: getByIdRes.ok, subject: getByIdRes.data?.subject || getByIdRes.data });

  // Step 4: GET single email by provider_id
  if (testEmail.provider_id && testEmail.provider_id !== testEmail.id) {
    const encodedPid = encodeURIComponent(testEmail.provider_id);
    const getByPidRes = await api("GET", `/api/v1/emails/${encodedPid}?account_id=${accountId}`);
    log(`GET /emails/${testEmail.provider_id} (by provider_id)`, { status: getByPidRes.status, ok: getByPidRes.ok, subject: getByPidRes.data?.subject || getByPidRes.data });
  }

  // Step 5: Try PUT with id (this is what our code does -- likely 404 for Outlook)
  const trashFolder = foldersRes.data.items?.find(f => f.role === "trash");
  if (!trashFolder) {
    console.log("No trash folder found, skipping PUT test");
    return;
  }

  // DRY RUN: just test if PUT works, don't actually move.
  // Try moving to the SAME folder it's already in (inbox) -- should be a no-op
  const putByIdRes = await api("PUT", `/api/v1/emails/${testEmail.id}?account_id=${accountId}`, {
    folders: [inbox.provider_id],
  });
  log(`PUT /emails/${testEmail.id} (by id, folders=[inbox])`, { status: putByIdRes.status, ok: putByIdRes.ok, data: putByIdRes.data });

  // Step 6: Try PUT with provider_id
  if (testEmail.provider_id && testEmail.provider_id !== testEmail.id) {
    const encodedPid = encodeURIComponent(testEmail.provider_id);
    const putByPidRes = await api("PUT", `/api/v1/emails/${encodedPid}?account_id=${accountId}`, {
      folders: [inbox.provider_id],
    });
    log(`PUT /emails/${testEmail.provider_id} (by provider_id, folders=[inbox])`, { status: putByPidRes.status, ok: putByPidRes.ok, data: putByPidRes.data });
  }

  // Step 7: Try PUT with folder name instead of provider_id
  const putWithNameRes = await api("PUT", `/api/v1/emails/${testEmail.id}?account_id=${accountId}`, {
    folders: [inbox.name],
  });
  log(`PUT /emails/${testEmail.id} (by id, folders=[${inbox.name}])`, { status: putWithNameRes.status, ok: putWithNameRes.ok, data: putWithNameRes.data });

  // Step 8: Try PUT with folder id
  const putWithFolderIdRes = await api("PUT", `/api/v1/emails/${testEmail.id}?account_id=${accountId}`, {
    folders: [inbox.id],
  });
  log(`PUT /emails/${testEmail.id} (by id, folders=[folder.id: ${inbox.id}])`, { status: putWithFolderIdRes.status, ok: putWithFolderIdRes.ok, data: putWithFolderIdRes.data });
}

// Run investigation
async function main() {
  await investigateAccount("Outlook (Unipile)", OUTLOOK_ACCOUNT_ID);
  if (GMAIL_ACCOUNT_ID) {
    await investigateAccount("Gmail (Unipile)", GMAIL_ACCOUNT_ID);
  }
}

main().catch(console.error);
