/**
 * Debug script: IMAP UID-based metadata fetch returns 0 results.
 *
 * Reproduces the issue where listInbox returns UIDs, but fetchMetaByUidBatch
 * on a NEW connection returns 0 results for those same UIDs.
 *
 * Hypothesis: client.fetch(uidSet, { uid: true }) passes uid:true as a fetch
 * FIELD (include uid in response), not as an OPTIONS parameter (interpret range
 * as UIDs). The fix would be: client.fetch(uidSet, { envelope: true }, { uid: true }).
 */

import { ImapFlow } from "imapflow";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

// ============================================================================
// CONSTANTS
// ============================================================================

const IMAP_HOST = process.env.IMAP_HOST!;
const IMAP_PORT = Number(process.env.IMAP_PORT!);
const IMAP_USER = process.env.IMAP_USER!;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD!;
const EMAIL_COUNT = 3;

// ============================================================================
// HELPERS
// ============================================================================

function createClient(): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });
}

function formatAddress(
  addresses: Array<{ name?: string; address?: string }> | undefined
): string {
  if (!addresses || addresses.length === 0) return "(unknown)";
  const addr = addresses[0];
  if (addr.name) return `${addr.name} <${addr.address ?? ""}>`;
  return addr.address ?? "(unknown)";
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== IMAP UID Enrichment Debug Test ===\n");

  // ---------------------------------------------------------------
  // Step 1: Connection A -- list last N emails (same as listInbox)
  // ---------------------------------------------------------------
  console.log("[STEP 1] Connecting to IMAP (Connection A) to list emails...");
  const clientA = createClient();
  await clientA.connect();
  console.log("[STEP 1] Connected.\n");

  const lock1 = await clientA.getMailboxLock("INBOX");
  const collectedUids: number[] = [];

  try {
    const mailbox = clientA.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      throw new Error("INBOX is empty");
    }

    const totalMessages = mailbox.exists;
    const startSeq = Math.max(1, totalMessages - EMAIL_COUNT + 1);
    const range = `${startSeq}:*`;

    console.log(
      `[STEP 1] INBOX has ${totalMessages} messages. Fetching sequence range ${range}...`
    );

    // This mirrors listInbox: sequence-based fetch, no uid option
    for await (const message of clientA.fetch(range, {
      envelope: true,
      bodyStructure: true,
    })) {
      if (message.envelope) {
        collectedUids.push(message.uid);
        console.log(
          `  UID ${message.uid} | seq ${message.seq} | ${message.envelope.subject}`
        );
      }
    }
  } finally {
    lock1.release();
  }

  console.log(`\n[STEP 1] Collected UIDs: [${collectedUids.join(", ")}]`);

  // Disconnect A
  await clientA.logout();
  console.log("[STEP 1] Connection A closed.\n");

  // ---------------------------------------------------------------
  // Step 2: Connection B -- fetch metadata by UID (BUGGY approach)
  // ---------------------------------------------------------------
  console.log(
    "[STEP 2] Connecting to IMAP (Connection B) -- simulating end-of-session hook..."
  );
  const clientB = createClient();
  await clientB.connect();
  console.log("[STEP 2] Connected.\n");

  const uidSet = collectedUids.join(",");

  // --- Approach A: BUGGY (current code) ---
  // uid:true is inside fetch fields, NOT in options. ImapFlow treats uidSet as
  // sequence numbers, not UIDs.
  console.log(
    `[STEP 2a] BUGGY fetch: client.fetch("${uidSet}", { envelope: true, uid: true })`
  );

  const buggyResults = new Map<number, { subject: string; from: string }>();
  const lockBuggy = await clientB.getMailboxLock("INBOX");

  try {
    for await (const message of clientB.fetch(uidSet, {
      envelope: true,
      uid: true,
    })) {
      if (message.envelope) {
        buggyResults.set(message.uid, {
          subject: message.envelope.subject ?? "(no subject)",
          from: formatAddress(message.envelope.from),
        });
      }
    }
  } catch (error) {
    console.log(`  ERROR: ${error}`);
  } finally {
    lockBuggy.release();
  }

  console.log(`  Results: ${buggyResults.size} emails found`);
  for (const [uid, meta] of buggyResults) {
    console.log(`    UID ${uid}: "${meta.subject}" from ${meta.from}`);
  }

  // Check which UIDs were found vs not
  const buggyFound = collectedUids.filter((u) => buggyResults.has(u));
  const buggyMissing = collectedUids.filter((u) => !buggyResults.has(u));
  console.log(`  Found UIDs: [${buggyFound.join(", ")}]`);
  console.log(`  Missing UIDs: [${buggyMissing.join(", ")}]`);

  // --- Approach B: FIXED (uid:true in OPTIONS parameter) ---
  console.log(
    `\n[STEP 2b] FIXED fetch: client.fetch("${uidSet}", { envelope: true }, { uid: true })`
  );

  const fixedResults = new Map<number, { subject: string; from: string }>();
  const lockFixed = await clientB.getMailboxLock("INBOX");

  try {
    for await (const message of clientB.fetch(uidSet, { envelope: true }, { uid: true })) {
      if (message.envelope) {
        fixedResults.set(message.uid, {
          subject: message.envelope.subject ?? "(no subject)",
          from: formatAddress(message.envelope.from),
        });
      }
    }
  } catch (error) {
    console.log(`  ERROR: ${error}`);
  } finally {
    lockFixed.release();
  }

  console.log(`  Results: ${fixedResults.size} emails found`);
  for (const [uid, meta] of fixedResults) {
    console.log(`    UID ${uid}: "${meta.subject}" from ${meta.from}`);
  }

  const fixedFound = collectedUids.filter((u) => fixedResults.has(u));
  const fixedMissing = collectedUids.filter((u) => !fixedResults.has(u));
  console.log(`  Found UIDs: [${fixedFound.join(", ")}]`);
  console.log(`  Missing UIDs: [${fixedMissing.join(", ")}]`);

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log("\n=== SUMMARY ===");
  console.log(`UIDs from listInbox:           [${collectedUids.join(", ")}]`);
  console.log(
    `BUGGY fetch matched:           ${buggyFound.length}/${collectedUids.length}`
  );
  console.log(
    `FIXED fetch matched:           ${fixedFound.length}/${collectedUids.length}`
  );

  if (buggyFound.length < fixedFound.length) {
    console.log(
      "\n>>> CONFIRMED: The bug is that uid:true must be in the OPTIONS param (3rd arg), not in fetch fields (2nd arg)."
    );
    console.log(
      '>>> Fix: change client.fetch(uidSet, { envelope: true, uid: true }) to client.fetch(uidSet, { envelope: true }, { uid: true })'
    );
  } else if (buggyFound.length === fixedFound.length && buggyFound.length === collectedUids.length) {
    console.log(
      "\n>>> Both approaches returned all UIDs. The UIDs happen to match sequence numbers (small mailbox). Try with a larger mailbox."
    );
  } else {
    console.log("\n>>> Unexpected result. Review the output above.");
  }

  await clientB.logout();
  console.log("\n[DONE] Connection B closed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
