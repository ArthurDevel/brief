/**
 * Verify POST /api/v1/drafts creates a real draft (not a sent email),
 * then test both DELETE /api/v1/drafts/{id} and DELETE /api/v1/emails/{id}
 * to find the correct delete path.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
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
const ACCOUNT_ID = "DMTYkh6uSWuy-M0MAOPTDg";

const outputDir = resolve(__dirname, "output");
mkdirSync(outputDir, { recursive: true });

async function probe(label, method, path, body = null) {
  const url = `${DSN}${path}`;
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${url}`);
  if (body) console.log("Body:", JSON.stringify(body, null, 2));

  const headers = {
    "X-API-KEY": API_KEY,
    "accept": "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }

  const result = { status: res.status, body: data };
  console.log(`Status: ${res.status}`);
  console.log("Response:", JSON.stringify(data, null, 2));

  const filename = `${label.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
  writeFileSync(resolve(outputDir, filename), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  // Step 0: List accounts to find a valid one
  const accountsResult = await probe("49_list_accounts", "GET", "/api/v1/accounts");

  // Step 1a: POST /api/v1/drafts with account_id in body
  const draftResult = await probe("50_create_draft_body", "POST", "/api/v1/drafts", {
    account_id: ACCOUNT_ID,
    to: [{ display_name: "Arthur Test", identifier: "arthur.stockman.other@gmail.com" }],
    subject: "DRAFT TEST - should NOT be sent",
    body: "This should appear in drafts folder, not be sent.",
  });

  const draftId = draftResult.body?.draft_id || draftResult.body?.id || draftResult.body?.tracking_id;
  console.log("\nDraft ID:", draftId);
  console.log("Object type:", draftResult.body?.object);

  if (!draftId) {
    console.log("\nNo draft ID returned, stopping here.");
    return;
  }

  // Step 2: Try DELETE /api/v1/drafts/{id} (dedicated drafts delete)
  await probe("51_delete_draft_via_drafts_endpoint", "DELETE", `/api/v1/drafts/${draftId}?account_id=${ACCOUNT_ID}`);

  // Step 3: Create another draft to test the other delete path
  const draft2Result = await probe("52_create_draft_2", "POST", "/api/v1/drafts", {
    account_id: ACCOUNT_ID,
    to: [{ display_name: "Arthur Test", identifier: "arthur.stockman.other@gmail.com" }],
    subject: "DRAFT TEST 2 - delete via emails endpoint",
    body: "Testing delete via /api/v1/emails/{id}.",
  });

  const draft2Id = draft2Result.body?.draft_id || draft2Result.body?.id || draft2Result.body?.tracking_id;
  console.log("\nDraft 2 ID:", draft2Id);

  if (draft2Id) {
    // Step 4: Try DELETE /api/v1/emails/{id} (generic email delete)
    await probe("53_delete_draft_via_emails_endpoint", "DELETE", `/api/v1/emails/${draft2Id}?account_id=${ACCOUNT_ID}`);
  }
}

main().catch(console.error);
