/**
 * Benchmarks sequential vs batched IMAP email metadata fetching.
 *
 * Responsibilities:
 * - Connects to IMAP using credentials from .env
 * - Fetches the first 50 UIDs from INBOX as a realistic test dataset
 * - Measures three approaches: fully sequential, batched by UID, and sequential-under-single-lock by Message-ID
 * - Prints a comparison table and saves results to output/results.json
 */

import "dotenv/config";
import { ImapFlow } from "imapflow";
import { writeFileSync } from "fs";

// ============================================================================
// CONSTANTS
// ============================================================================

const EMAIL_FETCH_COUNT = 50;
const RESULTS_OUTPUT_PATH = "./output/results.json";

// ============================================================================
// INTERFACES
// ============================================================================

interface EmailMetadata {
  uid: number;
  subject: string;
  from: string;
}

interface BenchmarkResult {
  approach: string;
  emailCount: number;
  totalTimeMs: number;
  avgTimePerEmailMs: number;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  // Step 1: Fetch UIDs to use as input for all approaches
  console.log("Connecting to IMAP...");
  let client = await createFreshClient();
  const uids = await fetchInboxUids(client, EMAIL_FETCH_COUNT);
  console.log(`Fetched ${uids.length} UIDs from INBOX\n`);
  await client.logout();

  // Step 2: Run each benchmark with a fresh connection to avoid interference
  client = await createFreshClient();
  const resultA = await benchmarkSequential(client, uids);
  await client.logout().catch(() => {});

  client = await createFreshClient();
  const resultB = await benchmarkBatched(client, uids);
  await client.logout().catch(() => {});

  client = await createFreshClient();
  const resultC = await benchmarkMessageIdSingleLock(client, uids);
  await client.logout().catch(() => {});

  const results = [resultA, resultB, resultC];

  // Step 3: Print and save results
  printResultsTable(results);
  saveResults(results);
}

// ============================================================================
// BENCHMARK APPROACHES
// ============================================================================

/**
 * Approach A: Sequential fetching (mirrors current production behavior).
 * Acquires and releases the mailbox lock once per UID.
 *
 * @param client - Connected ImapFlow client
 * @param uids - List of UIDs to fetch
 * @returns Benchmark result with timing data
 */
async function benchmarkSequential(
  client: ImapFlow,
  uids: number[]
): Promise<BenchmarkResult> {
  console.log("Running Approach A: Sequential (one lock per UID)...");
  const start = Date.now();

  for (const uid of uids) {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    } finally {
      lock.release();
    }
  }

  const totalTimeMs = Date.now() - start;
  return buildResult("A: Sequential (lock-per-UID)", uids.length, totalTimeMs);
}

/**
 * Approach B: Batched fetch by UID.
 * Acquires the mailbox lock once, fetches all UIDs in a single FETCH command,
 * then releases the lock.
 *
 * @param client - Connected ImapFlow client
 * @param uids - List of UIDs to fetch
 * @returns Benchmark result with timing data
 */
async function benchmarkBatched(
  client: ImapFlow,
  uids: number[]
): Promise<BenchmarkResult> {
  console.log("Running Approach B: Batched (single lock, single FETCH)...");
  const start = Date.now();

  const uidSet = uids.join(",");
  const lock = await client.getMailboxLock("INBOX");

  try {
    // client.fetch() returns an async iterable; we consume it fully
    for await (const _message of client.fetch(
      uidSet,
      { envelope: true },
      { uid: true }
    )) {
      // envelope data available as _message.envelope if needed
    }
  } finally {
    lock.release();
  }

  const totalTimeMs = Date.now() - start;
  return buildResult("B: Batched (single FETCH)", uids.length, totalTimeMs);
}

/**
 * Approach C: Sequential by Message-ID under a single lock.
 * First does one batch fetch to collect messageId values, then searches
 * for each by Message-ID header — but holds the lock open for all iterations
 * instead of re-acquiring it per message.
 *
 * This simulates the case where the app only has Message-IDs (not UIDs) and
 * needs to resolve them one-at-a-time, but avoids per-iteration lock overhead.
 *
 * @param client - Connected ImapFlow client
 * @param uids - List of UIDs whose Message-IDs we'll resolve and then re-search
 * @returns Benchmark result with timing data
 */
async function benchmarkMessageIdSingleLock(
  client: ImapFlow,
  uids: number[]
): Promise<BenchmarkResult> {
  console.log(
    "Running Approach C: Sequential by Message-ID under single lock..."
  );

  // Step 1: Collect all messageId values with one batch fetch
  const messageIds = await fetchMessageIds(client, uids);
  console.log(`  Collected ${messageIds.length} message IDs`);

  // Step 2: Hold the lock open for all Message-ID searches
  const start = Date.now();
  const lock = await client.getMailboxLock("INBOX");

  try {
    for (const messageId of messageIds) {
      // Search returns a list of matching UIDs
      const matchingUids = await client.search(
        { header: { "message-id": messageId } },
        { uid: true }
      );

      if (matchingUids.length === 0) {
        continue;
      }

      // Fetch the envelope for the first matching UID
      await client.fetchOne(
        String(matchingUids[0]),
        { envelope: true },
        { uid: true }
      );
    }
  } finally {
    lock.release();
  }

  const totalTimeMs = Date.now() - start;
  return buildResult(
    "C: Sequential by Message-ID (single lock)",
    messageIds.length,
    totalTimeMs
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates and configures an ImapFlow client from environment variables.
 * Throws if required env vars are missing.
 *
 * @returns Configured ImapFlow client (not yet connected)
 */
function getImapConfig() {
  const host = process.env.IMAP_HOST;
  const port = process.env.IMAP_PORT;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!host || !port || !user || !password) {
    throw new Error(
      "Missing required env vars: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD"
    );
  }

  return { host, port: Number(port), user, password };
}

/**
 * Creates and configures an ImapFlow client from environment variables.
 * Attaches an error handler so unhandled socket errors don't crash the process.
 *
 * @returns Configured ImapFlow client (not yet connected)
 */
function createImapClient(): ImapFlow {
  const config = getImapConfig();

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });

  // Prevent unhandled 'error' events from crashing the process
  client.on("error", (err: Error) => {
    console.error(`  [ImapFlow error] ${err.message}`);
  });

  return client;
}

/**
 * Creates a fresh IMAP client and connects it.
 * Used to get a clean connection between benchmark runs.
 *
 * @returns Connected ImapFlow client
 */
async function createFreshClient(): Promise<ImapFlow> {
  const client = createImapClient();
  await client.connect();
  return client;
}

/**
 * Fetches the first N UIDs from INBOX.
 *
 * @param client - Connected ImapFlow client
 * @param count - Maximum number of UIDs to return
 * @returns Array of UID numbers
 */
async function fetchInboxUids(
  client: ImapFlow,
  count: number
): Promise<number[]> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    // Search for all messages, then take the first `count`
    const allUids = await client.search({ all: true }, { uid: true });
    return allUids.slice(0, count);
  } finally {
    lock.release();
  }
}

/**
 * Fetches Message-ID header values for a list of UIDs using a single batch FETCH.
 *
 * @param client - Connected ImapFlow client
 * @param uids - List of UIDs to fetch Message-IDs for
 * @returns Array of Message-ID strings (skips messages with no messageId)
 */
async function fetchMessageIds(
  client: ImapFlow,
  uids: number[]
): Promise<string[]> {
  const messageIds: string[] = [];
  const uidSet = uids.join(",");
  const lock = await client.getMailboxLock("INBOX");

  try {
    for await (const message of client.fetch(
      uidSet,
      { envelope: true },
      { uid: true }
    )) {
      const messageId = message.envelope?.messageId;
      if (messageId) {
        messageIds.push(messageId);
      }
    }
  } finally {
    lock.release();
  }

  return messageIds;
}

/**
 * Builds a BenchmarkResult from raw timing data.
 *
 * @param approach - Human-readable name for the approach
 * @param emailCount - Number of emails processed
 * @param totalTimeMs - Total elapsed milliseconds
 * @returns Populated BenchmarkResult
 */
function buildResult(
  approach: string,
  emailCount: number,
  totalTimeMs: number
): BenchmarkResult {
  return {
    approach,
    emailCount,
    totalTimeMs,
    avgTimePerEmailMs: Math.round((totalTimeMs / emailCount) * 10) / 10,
  };
}

/**
 * Prints benchmark results as a formatted table to stdout.
 *
 * @param results - Array of benchmark results to display
 */
function printResultsTable(results: BenchmarkResult[]): void {
  console.log("\n");
  console.log("=".repeat(72));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(72));
  console.log(
    "Approach".padEnd(44) +
      "Emails".padEnd(10) +
      "Total (ms)".padEnd(12) +
      "Avg (ms)"
  );
  console.log("-".repeat(72));

  for (const r of results) {
    console.log(
      r.approach.padEnd(44) +
        String(r.emailCount).padEnd(10) +
        String(r.totalTimeMs).padEnd(12) +
        String(r.avgTimePerEmailMs)
    );
  }

  console.log("=".repeat(72));
  console.log();
}

/**
 * Saves benchmark results as JSON to the output directory.
 *
 * @param results - Array of benchmark results to save
 */
function saveResults(results: BenchmarkResult[]): void {
  const output = {
    timestamp: new Date().toISOString(),
    results,
  };

  writeFileSync(RESULTS_OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Results saved to ${RESULTS_OUTPUT_PATH}`);
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
