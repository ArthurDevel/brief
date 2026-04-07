/**
 * Standalone Unipile API exploration script.
 *
 * Probes the real Unipile API to verify endpoint shapes, field names,
 * auth headers, and request formats. Saves raw JSON responses to output/.
 *
 * Usage: node explore.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dependencies)
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

if (!DSN || !API_KEY) {
  console.error("Missing UNIPILE_DSN or UNIPILE_API_KEY in .env");
  process.exit(1);
}

const outputDir = resolve(__dirname, "output");
mkdirSync(outputDir, { recursive: true });

// ============================================================================
// HELPERS
// ============================================================================

async function probe(label, method, path, body = null, extraHeaders = {}) {
  const url = `${DSN}${path}`;
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${url}`);

  const headers = {
    "X-API-KEY": API_KEY,
    "accept": "application/json",
    ...extraHeaders,
  };
  if (body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }

    const result = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body: data,
    };

    const filename = `${label.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
    writeFileSync(resolve(outputDir, filename), JSON.stringify(result, null, 2));

    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Response keys: ${typeof data === "object" && data !== null ? Object.keys(data).join(", ") : "N/A"}`);

    if (res.status >= 400) {
      console.log(`Error body: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.log(`FETCH ERROR: ${err.message}`);
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

// ============================================================================
// PROBES
// ============================================================================

async function run() {
  console.log("=== Unipile API Exploration ===");
  console.log(`DSN: ${DSN}`);
  console.log(`API Key: ${API_KEY.slice(0, 10)}...`);

  // 1. List accounts -- find an account_id to use for further probes
  const accounts = await probe("01_list_accounts", "GET", "/api/v1/accounts");

  let accountId = null;
  if (accounts.ok && accounts.data?.items?.length > 0) {
    accountId = accounts.data.items[0].id;
    console.log(`\nUsing account_id: ${accountId}`);
    console.log(`Account fields: ${JSON.stringify(Object.keys(accounts.data.items[0]))}`);
    console.log(`Account sample: ${JSON.stringify(accounts.data.items[0], null, 2).slice(0, 500)}`);
  } else if (accounts.ok && Array.isArray(accounts.data) && accounts.data.length > 0) {
    accountId = accounts.data[0].id;
    console.log(`\nUsing account_id: ${accountId}`);
  } else {
    console.log("\nNo accounts found. Most probes will fail.");
  }

  // 2. Get single account detail
  if (accountId) {
    await probe("02_get_account", "GET", `/api/v1/accounts/${accountId}`);
  }

  // 3. List emails (inbox)
  if (accountId) {
    const emails = await probe("03_list_emails", "GET", `/api/v1/emails?account_id=${accountId}&limit=3`);

    // Inspect first email object shape
    const items = emails.data?.items ?? (Array.isArray(emails.data) ? emails.data : []);
    if (items.length > 0) {
      const firstEmail = items[0];
      console.log(`\nEmail object keys: ${JSON.stringify(Object.keys(firstEmail))}`);
      console.log(`Email sample (truncated): ${JSON.stringify(firstEmail, null, 2).slice(0, 800)}`);

      // 4. Get single email detail
      const emailId = firstEmail.id;
      if (emailId) {
        await probe("04_get_email", "GET", `/api/v1/emails/${emailId}`);
      }

      // 5. Try thread endpoint (may not exist)
      if (emailId) {
        await probe("05_get_thread", "GET", `/api/v1/emails/${emailId}/thread`);
      }
    }
  }

  // 6. Search emails
  if (accountId) {
    await probe("06_search_emails", "GET", `/api/v1/emails?account_id=${accountId}&q=test&limit=2`);
  }

  // 7. List folders
  if (accountId) {
    const folders = await probe("07_list_folders", "GET", `/api/v1/folders?account_id=${accountId}`);
    const folderItems = folders.data?.items ?? (Array.isArray(folders.data) ? folders.data : []);
    if (folderItems.length > 0) {
      console.log(`\nFolder object keys: ${JSON.stringify(Object.keys(folderItems[0]))}`);
      console.log(`Folder sample: ${JSON.stringify(folderItems[0], null, 2).slice(0, 300)}`);
    }
  }

  // 8. List contacts
  if (accountId) {
    await probe("08_list_contacts", "GET", `/api/v1/emails/contacts?account_id=${accountId}&limit=5`);
  }

  // 9. Try update email (mark as read) -- use PUT
  // We will NOT actually mutate, just probe the shape by sending a GET to see error message
  if (accountId) {
    // Probe: what does PUT /api/v1/emails/{id} expect?
    // Use a dummy ID to see the error shape without modifying real data
    await probe("09_update_email_probe", "PUT", `/api/v1/emails/fake_id_probe`, { is_read: true });
  }

  // 10. Test auth header formats
  // Try with Authorization: Bearer (our current code in packages/email)
  if (accountId) {
    const url = `/api/v1/accounts`;
    console.log("\n--- 10_auth_bearer_test ---");
    console.log(`Testing Authorization: Bearer header...`);
    try {
      const res = await fetch(`${DSN}${url}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "accept": "application/json",
        },
      });
      const data = await res.json().catch(() => ({}));
      writeFileSync(resolve(outputDir, "10_auth_bearer_test.json"), JSON.stringify({ status: res.status, body: data }, null, 2));
      console.log(`Bearer auth status: ${res.status}`);
    } catch (err) {
      console.log(`Bearer auth error: ${err.message}`);
    }

    // Try with Access-Token header (mentioned in some docs)
    console.log("\n--- 11_auth_access_token_test ---");
    console.log(`Testing Access-Token header...`);
    try {
      const res = await fetch(`${DSN}${url}`, {
        method: "GET",
        headers: {
          "Access-Token": API_KEY,
          "accept": "application/json",
        },
      });
      const data = await res.json().catch(() => ({}));
      writeFileSync(resolve(outputDir, "11_auth_access_token_test.json"), JSON.stringify({ status: res.status, body: data }, null, 2));
      console.log(`Access-Token auth status: ${res.status}`);
    } catch (err) {
      console.log(`Access-Token auth error: ${err.message}`);
    }
  }

  // 11. Test hosted auth link creation format
  // Probe with providers (array) vs provider (singular)
  await probe("12_hosted_auth_providers_array", "POST", "/api/v1/hosted/accounts/link", {
    type: "create",
    providers: ["GOOGLE"],
    api_url: DSN,
    expires_on: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    name: "test_probe",
  });

  await probe("13_hosted_auth_provider_singular", "POST", "/api/v1/hosted/accounts/link", {
    type: "create",
    provider: "GOOGLE",
    api_url: DSN,
    expires_on: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    name: "test_probe",
  });

  // 12. Try draft creation endpoint
  if (accountId) {
    // Probe the dedicated drafts endpoint (don't actually send)
    await probe("14_create_draft_probe", "POST", "/api/v1/emails/drafts", {
      account_id: accountId,
      subject: "TEST DRAFT - DO NOT SEND",
      body: "This is a probe draft.",
      to: [{ display_name: "Test", identifier: "test@example.com" }],
    });
  }

  console.log("\n\n=== EXPLORATION COMPLETE ===");
  console.log(`Results saved to: ${outputDir}/`);
}

run().catch(console.error);
