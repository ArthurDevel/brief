/**
 * Simulates the Gmail IMAP beforeAll hook step-by-step with detailed timing
 * to identify exactly where the 180s timeout occurs.
 *
 * This replicates the logic from email-client.e2e.ts beforeAll for the IMAP path.
 *
 * Usage: npx tsx simulate-beforeall.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

config({ path: resolve(import.meta.dirname, ".env") });

// Also load the main test env vars (Unipile keys etc)
config({ path: resolve(import.meta.dirname, "../../.env.test.local") });

// ============================================================================
// CONSTANTS
// ============================================================================

const TAG = "[e2e-ts]";
const DELIVERY_WAIT_MS = 15_000;
const SEED_CACHE_PATH = resolve(
  import.meta.dirname,
  "../../packages/email/src/__tests__/e2e/.seed-cache.json"
);

const POOL_KEYS = [
  "seed", "thread", "search",
  "deleteRecipe", "archiveForward", "archiveUndo",
  "deleteForward", "deleteUndo",
  "moveForward", "moveUndo", "moveNonexistent",
  "moveUserFolder", "moveUserFolderUndo",
] as const;

type PoolKey = typeof POOL_KEYS[number];

function poolSubject(key: PoolKey): string {
  if (key === "seed") return `${TAG} Seed email`;
  if (key === "thread") return `${TAG} Thread test`;
  if (key === "search") return `${TAG} Searchable uniquetoken`;
  return `${TAG} Pool ${key}`;
}

const ACCOUNT_ID = "test-gmail-imap";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main() {
  const totalT0 = Date.now();
  const log = (msg: string) => console.log(`[+${Date.now() - totalT0}ms] ${msg}`);

  log("=== Simulating Gmail IMAP beforeAll ===");

  // Step 1: Read seed cache
  log("Reading seed cache...");
  let cache: Record<string, Record<string, string>> = {};
  try {
    cache = JSON.parse(readFileSync(SEED_CACHE_PATH, "utf-8"));
    log(`Cache loaded. Keys: ${Object.keys(cache).join(", ")}`);
  } catch {
    log("No cache file found");
  }

  const cached = cache[ACCOUNT_ID] ?? {};
  log(`Cached entries for ${ACCOUNT_ID}: ${Object.keys(cached).length}`);
  for (const [key, id] of Object.entries(cached)) {
    log(`  ${key}: UID=${id}`);
  }

  // Step 2: Create IMAP client
  log("\nCreating IMAP client via createEmailAccountClient...");
  const { createEmailAccountClient } = await import("../../packages/email/src/account-client");
  const record = {
    id: ACCOUNT_ID,
    userId: "test-user",
    provider: "gmail" as const,
    connectionType: "imap_smtp" as const,
    emailAddress: process.env.TEST_GMAIL_IMAP_EMAIL!,
    unipileAccountId: null,
    status: "active",
    lastError: null,
    customConfig: {
      imap: {
        host: process.env.TEST_GMAIL_IMAP_HOST!,
        port: Number(process.env.TEST_GMAIL_IMAP_PORT!),
        user: process.env.TEST_GMAIL_IMAP_USER!,
        password: process.env.TEST_GMAIL_IMAP_PASSWORD!,
      },
      smtp: {
        host: process.env.TEST_GMAIL_SMTP_HOST!,
        port: Number(process.env.TEST_GMAIL_SMTP_PORT!),
        user: process.env.TEST_GMAIL_SMTP_USER!,
        password: process.env.TEST_GMAIL_SMTP_PASSWORD!,
      },
    },
  };

  const client = await createEmailAccountClient(record);
  log("Client created");

  // Step 3: Validate each cached email
  log("\nValidating cached emails...");
  const pool: Record<string, string> = {};
  const missing: PoolKey[] = [];

  for (const key of POOL_KEYS) {
    const id = cached[key];
    if (!id) {
      log(`  ${key}: NOT IN CACHE`);
      missing.push(key);
      continue;
    }

    const t0 = Date.now();
    try {
      const email = await client.readEmail(id);
      const dur = Date.now() - t0;
      log(`  ${key}: UID=${id} VALID (${dur}ms) - "${email.subject}"`);
      pool[key] = id;
    } catch (err) {
      const dur = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ${key}: UID=${id} INVALID (${dur}ms) - ${msg}`);
      missing.push(key);
    }
  }

  log(`\nResult: ${Object.keys(pool).length} valid, ${missing.length} missing`);
  if (missing.length > 0) {
    log(`Missing keys: ${missing.join(", ")}`);
  }

  // Step 4: Re-seed if needed
  if (missing.length > 0) {
    log(`\nRe-seeding ${missing.length} emails...`);

    for (const key of missing) {
      const t0 = Date.now();
      const subject = poolSubject(key);
      try {
        await client.sendEmail({
          to: record.emailAddress!,
          subject,
          body: `Pool email: ${key}`,
        });
        log(`  Sent "${subject}" (${Date.now() - t0}ms)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  SEND FAILED "${subject}" (${Date.now() - t0}ms): ${msg}`);
      }
    }

    log(`\nWaiting ${DELIVERY_WAIT_MS}ms for delivery...`);
    await new Promise((r) => setTimeout(r, DELIVERY_WAIT_MS));

    log("\nFinding re-seeded emails...");
    for (const key of missing) {
      const subject = poolSubject(key);
      const t0 = Date.now();
      try {
        const id = await findEmailBySubject(client, subject, log);
        pool[key] = id;
        log(`  Found "${subject}" as UID=${id} (${Date.now() - t0}ms)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  FIND FAILED "${subject}" (${Date.now() - t0}ms): ${msg}`);
      }
    }
  }

  const totalDur = Date.now() - totalT0;
  log(`\n=== beforeAll simulation complete: ${totalDur}ms (${(totalDur / 1000).toFixed(1)}s) ===`);
  log(`Valid pool entries: ${Object.keys(pool).length}/${POOL_KEYS.length}`);

  // Warn if this would have timed out
  if (totalDur > 180_000) {
    log("WARNING: This would have exceeded the 180s beforeAll timeout!");
  } else if (totalDur > 120_000) {
    log("WARNING: This would have exceeded the 120s hookTimeout in vitest.e2e.config.ts!");
  }

  process.exit(0);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface EmailClient {
  listInbox(limit: number): Promise<Array<{ id: string; subject: string }>>;
  searchEmails(query: string): Promise<Array<{ id: string; subject: string }>>;
  sendEmail(input: { to: string; subject: string; body: string }): Promise<void>;
  readEmail(id: string): Promise<{ subject: string }>;
}

async function findEmailBySubject(
  client: EmailClient,
  subject: string,
  log: (msg: string) => void
): Promise<string> {
  const MAX_RETRIES = 12;
  const RETRY_WAIT_MS = 5_000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    const emails = await client.listInbox(50);
    const dur = Date.now() - t0;
    const found = emails.find((e) => e.subject.includes(subject));
    if (found) return found.id;

    log(`    attempt ${attempt + 1}: not found in ${emails.length} emails (${dur}ms). Top subjects: ${emails.slice(0, 3).map((e) => `"${e.subject}"`).join(", ")}`);

    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }

  throw new Error(`Could not find "${subject}" after ${MAX_RETRIES} attempts`);
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
