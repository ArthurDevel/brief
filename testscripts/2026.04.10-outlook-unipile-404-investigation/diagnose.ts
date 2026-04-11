/**
 * Diagnose Outlook Unipile 404 errors in e2e mutation tests.
 *
 * Investigates two issues:
 * 1. Seed cache has 9 pool keys pointing to the same email ID
 * 2. getRfcMessageId returns 404 when fetching email headers
 *
 * Usage: npx tsx diagnose.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

config({ path: resolve(import.meta.dirname, ".env") });

// ============================================================================
// CONSTANTS
// ============================================================================

const ACCOUNT_ID = process.env.TEST_OUTLOOK_UNIPILE_ACCOUNT_ID!;
const DSN = process.env.UNIPILE_DSN!;
const API_KEY = process.env.UNIPILE_API_KEY!;
const TAG = "[e2e-ts]";

const POOL_KEYS = [
  "seed", "thread", "search",
  "deleteRecipe", "archiveForward", "archiveUndo",
  "deleteForward", "deleteUndo",
  "moveForward", "moveUndo", "moveNonexistent",
  "moveUserFolder", "moveUserFolderUndo",
] as const;

function poolSubject(key: string): string {
  if (key === "seed") return `${TAG} Seed email`;
  if (key === "thread") return `${TAG} Thread test`;
  if (key === "search") return `${TAG} Searchable uniquetoken`;
  return `${TAG} Pool ${key}`;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main() {
  console.log("=== Outlook Unipile 404 Diagnosis ===\n");

  // Step 1: Check the seed cache
  console.log("--- Step 1: Seed Cache Analysis ---");
  const cachePath = resolve(import.meta.dirname, "../../packages/email/src/__tests__/e2e/.seed-cache.json");
  const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
  const outlookCache = cache["test-outlook-unipile"] ?? {};

  const idCounts: Record<string, string[]> = {};
  for (const [key, id] of Object.entries(outlookCache)) {
    const idStr = id as string;
    if (!idCounts[idStr]) idCounts[idStr] = [];
    idCounts[idStr].push(key);
  }

  console.log(`Total cached keys: ${Object.keys(outlookCache).length}`);
  console.log(`Unique IDs: ${Object.keys(idCounts).length}`);
  for (const [id, keys] of Object.entries(idCounts)) {
    if (keys.length > 1) {
      console.log(`  DUPLICATE: ${id.slice(-20)}... -> [${keys.join(", ")}]`);
    }
  }

  // Step 2: Check which cached IDs are actually valid
  console.log("\n--- Step 2: Validate Cached IDs ---");
  for (const [key, id] of Object.entries(outlookCache)) {
    const idStr = id as string;
    try {
      const data = await unipileGet(`/api/v1/emails/${idStr}?account_id=${ACCOUNT_ID}`);
      const subject = (data as any).subject ?? "(no subject)";
      const folders = (data as any).folders ?? [];
      console.log(`  ${key}: VALID - "${subject}" folders=${JSON.stringify(folders)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${key}: INVALID - ${msg}`);
    }
  }

  // Step 3: Check what searchEmails returns for pool subjects
  console.log("\n--- Step 3: Search Results for Pool Subjects ---");
  console.log("Testing what the Unipile search API returns for each pool subject...\n");

  for (const key of POOL_KEYS) {
    const subject = poolSubject(key);
    const data = await unipileGet(`/api/v1/emails?account_id=${ACCOUNT_ID}&limit=5`);
    // Unipile doesn't have a subject search param -- it returns all emails
    // searchEmails in the e2e test uses client.searchEmails which for Unipile calls unipile searchEmails
    // Let me check what that actually does
  }

  // Actually, let me check what searchEmails does for Unipile
  console.log("Checking how Unipile search works...");
  // The e2e test for Outlook uses findEmailBySubject -> client.searchEmails(subject)
  // For Unipile, searchEmails is in unipile-client.ts
  // Let me search directly with the API

  for (const key of ["seed", "deleteRecipe", "archiveForward", "archiveUndo"] as const) {
    const subject = poolSubject(key);
    console.log(`\n  Searching for: "${subject}"`);

    // Try the search endpoint
    const data = await unipileGet(`/api/v1/emails?account_id=${ACCOUNT_ID}&limit=10&q=${encodeURIComponent(subject)}`);
    const items = ((data as any).items ?? []) as Array<Record<string, unknown>>;
    console.log(`  Results: ${items.length}`);
    for (const item of items.slice(0, 5)) {
      console.log(`    id=${(item.provider_id as string)?.slice(-20)}... subject="${item.subject}" folders=${JSON.stringify(item.folders)}`);
    }
  }

  // Step 4: Test what the e2e code path actually does
  console.log("\n--- Step 4: Simulate findEmailBySubject for Outlook ---");
  console.log("Using the actual e2e code path (client.searchEmails)...\n");

  // Import the actual client
  config({ path: resolve(import.meta.dirname, "../../.env.test.local") });
  const { createEmailAccountClient } = await import("../../packages/email/src/account-client");

  const record = {
    id: "test-outlook-unipile",
    userId: "test-user",
    provider: "outlook" as const,
    connectionType: "unipile" as const,
    emailAddress: process.env.TEST_OUTLOOK_UNIPILE_EMAIL!,
    unipileAccountId: ACCOUNT_ID,
    status: "active",
    lastError: null,
  };

  const client = await createEmailAccountClient(record);

  for (const key of POOL_KEYS) {
    const subject = poolSubject(key);
    const results = await client.searchEmails(subject);
    const first = results[0];
    console.log(`  "${subject}" -> ${results.length} results, first: id=${first?.id?.slice(-20)} "${first?.subject}"`);
  }

  // Step 5: Check if the 404 email exists at all
  console.log("\n--- Step 5: Check the 404 Email ---");
  const failingId = "AQMkADAwATM3ZmYBLWFlZDQtOGY2YS0wMAItMDAKAEYAAAPJoYNOpFERRLeW7kbUpxE_BwAXLXF5yqNJRZbmoqzzPyeCAAACAQwAAAAXLXF5yqNJRZbmoqzzPyeCAAACCTkAAAA=";
  console.log(`Checking if the failing email (${failingId.slice(-20)}...) exists...`);
  try {
    const data = await unipileGet(`/api/v1/emails/${failingId}?account_id=${ACCOUNT_ID}&include_headers=true`);
    console.log(`  EXISTS: subject="${(data as any).subject}" folders=${JSON.stringify((data as any).folders)}`);
  } catch (err) {
    console.log(`  NOT FOUND: ${(err as Error).message}`);
  }

  // Write results
  const outputPath = resolve(import.meta.dirname, "output", "diagnosis.json");
  writeFileSync(outputPath, JSON.stringify({ cache: outlookCache, idCounts }, null, 2));
  console.log(`\nResults written to: ${outputPath}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function unipileGet(path: string): Promise<Record<string, unknown>> {
  const url = `${DSN}${path}`;
  const res = await fetch(url, {
    headers: { "X-API-KEY": API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unipile GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
