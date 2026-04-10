/**
 * Investigation script: Full undo flow for email move/delete/archive.
 *
 * Tests whether the undo step (PUT to move email back) works for both
 * Gmail and Outlook via Unipile. Specifically investigates:
 *
 * - Category 2: Outlook 404 on undo PUT (provider_id changes after move?)
 * - Category 3: Gmail email not found in inbox after undo PUT
 *
 * Run: node --env-file=.env test-undo-flow.mjs
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;

const ACCOUNTS = [
  {
    label: "Gmail",
    accountId: process.env.TEST_GMAIL_UNIPILE_ACCOUNT_ID,
    email: process.env.TEST_GMAIL_UNIPILE_EMAIL,
  },
  {
    label: "Outlook",
    accountId: process.env.TEST_OUTLOOK_UNIPILE_ACCOUNT_ID,
    email: process.env.TEST_OUTLOOK_UNIPILE_EMAIL,
  },
];

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 15;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Make a Unipile API call. Logs method, path, status, and response body.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. /api/v1/emails)
 * @param {object|undefined} body - Request body (JSON)
 * @returns {{ status: number, ok: boolean, data: any }}
 */
async function api(method, path, body) {
  const url = `${DSN}${path}`;
  const opts = {
    method,
    headers: { "X-API-KEY": API_KEY, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  console.log(`  [${method}] ${path}`);
  console.log(`    status: ${res.status} (ok: ${res.ok})`);
  console.log(`    body: ${JSON.stringify(data, null, 2).split("\n").join("\n    ")}`);

  return { status: res.status, ok: res.ok, data };
}

/**
 * Print a section header.
 */
function section(title) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

/**
 * Print a step header.
 */
function step(num, title) {
  console.log(`\n--- Step ${num}: ${title} ---`);
}

/**
 * Wait for ms milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll inbox until an email matching the subject is found.
 * @param {string} accountId
 * @param {string} folderProviderId - provider_id of the inbox folder
 * @param {string} subject - subject to search for
 * @returns {{ found: boolean, email: object|null, attempts: number }}
 */
async function pollForEmail(accountId, folderProviderId, subject) {
  const encodedFolder = encodeURIComponent(folderProviderId);

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    console.log(`    poll attempt ${attempt}/${POLL_MAX_ATTEMPTS}...`);
    const res = await fetch(`${DSN}/api/v1/emails?account_id=${accountId}&limit=10&folder=${encodedFolder}`, {
      headers: { "X-API-KEY": API_KEY },
    });
    const data = await res.json();
    const match = data.items?.find((e) => e.subject === subject);
    if (match) {
      console.log(`    found email: id=${match.id}, provider_id=${match.provider_id}`);
      return { found: true, email: match, attempts: attempt };
    }
    if (attempt < POLL_MAX_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  console.log(`    email NOT found after ${POLL_MAX_ATTEMPTS} attempts`);
  return { found: false, email: null, attempts: POLL_MAX_ATTEMPTS };
}

/**
 * Search for an email in a specific folder by subject.
 * @param {string} accountId
 * @param {string} folderProviderId
 * @param {string} subject
 * @returns {object|null}
 */
async function findEmailInFolder(accountId, folderProviderId, subject) {
  const encodedFolder = encodeURIComponent(folderProviderId);
  const res = await fetch(`${DSN}/api/v1/emails?account_id=${accountId}&limit=20&folder=${encodedFolder}`, {
    headers: { "X-API-KEY": API_KEY },
  });
  const data = await res.json();
  return data.items?.find((e) => e.subject === subject) || null;
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Resolve key folders (inbox, trash, archive) for an account.
 * @param {string} accountId
 * @returns {{ inbox: object, trash: object, archive: object|null, all: object[] }}
 */
async function resolveFolders(accountId) {
  step("A", "Resolve folders");
  const res = await api("GET", `/api/v1/folders?account_id=${accountId}`);
  if (!res.ok) throw new Error(`Failed to list folders: ${res.status}`);

  const folders = res.data.items || [];
  const inbox = folders.find((f) => f.role === "inbox");
  const trash = folders.find((f) => f.role === "trash");
  const archive = folders.find((f) => f.role === "archive") || null;

  if (!inbox) throw new Error("No inbox folder found");
  if (!trash) throw new Error("No trash folder found");

  console.log("\n  Key folders:");
  for (const [label, folder] of [["inbox", inbox], ["trash", trash], ["archive", archive]]) {
    if (folder) {
      console.log(`    ${label}: id=${folder.id}, provider_id=${folder.provider_id}, role=${folder.role}`);
    } else {
      console.log(`    ${label}: (not found)`);
    }
  }

  return { inbox, trash, archive, all: folders };
}

/**
 * Send an email to self for testing.
 * @param {string} accountId
 * @param {string} email
 * @param {string} subject
 * @returns {object}
 */
async function sendTestEmail(accountId, email, subject) {
  step("B", `Send test email to self (${email})`);
  const res = await api("POST", `/api/v1/emails`, {
    account_id: accountId,
    to: [{ identifier: email }],
    subject,
    body: `Undo flow investigation test -- ${new Date().toISOString()}`,
  });
  if (!res.ok) throw new Error(`Failed to send email: ${res.status}`);
  return res.data;
}

/**
 * Run the full undo flow test for a single account.
 */
async function testUndoFlow(account) {
  const { label, accountId, email } = account;
  section(`${label} (account: ${accountId}, email: ${email})`);

  // Helper: PUT with account_id in the URL (matches production code in unipile-client.ts)
  function putEmail(emailId, body, encode = false) {
    const id = encode ? encodeURIComponent(emailId) : emailId;
    return api("PUT", `/api/v1/emails/${id}?account_id=${accountId}`, body);
  }

  // Step A: Resolve folders
  const { inbox, trash } = await resolveFolders(accountId);

  // Step B: Send test email
  const subject = `undo-test-${label.toLowerCase()}-${Date.now()}`;
  await sendTestEmail(accountId, email, subject);

  // Step C: Wait for email to arrive in inbox
  step("C", "Wait for email to appear in inbox");
  const inboxPoll = await pollForEmail(accountId, inbox.provider_id, subject);
  if (!inboxPoll.found) {
    console.log("  ABORT: email never arrived in inbox");
    return;
  }

  const originalEmail = inboxPoll.email;
  const originalProviderId = originalEmail.provider_id;
  const originalUnipileId = originalEmail.id;
  console.log(`\n  Original email IDs:`);
  console.log(`    unipile id:  ${originalUnipileId}`);
  console.log(`    provider_id: ${originalProviderId}`);

  // Note: Production code (mapToEmailSummary) uses provider_id as the email ID.
  // resolveFolderByRole returns folder.id (NOT folder.provider_id).
  // So the production PUT is: PUT /api/v1/emails/{provider_id}?account_id=... { folders: [folder.id] }
  console.log(`\n  Production code would use:`);
  console.log(`    email identifier: provider_id (${originalProviderId})`);
  console.log(`    trash folder:     folder.id (${trash.id})`);

  // Step D: Move to trash -- test all ID combos to see which works
  step("D", "Move email to trash via PUT");

  console.log("\n  D.1: PUT with provider_id + folder.id (production path)");
  const d1 = await putEmail(originalProviderId, { folders: [trash.id] }, true);

  if (!d1.ok) {
    console.log(`  D.1 FAILED (${d1.status}). Trying D.2: PUT with provider_id + folder.provider_id`);
    const d2 = await putEmail(originalProviderId, { folders: [trash.provider_id] }, true);

    if (!d2.ok) {
      console.log(`  D.2 FAILED (${d2.status}). Trying D.3: PUT with unipile_id + folder.id`);
      const d3 = await putEmail(originalUnipileId, { folders: [trash.id] });

      if (!d3.ok) {
        console.log(`  D.3 FAILED (${d3.status}). Trying D.4: PUT with unipile_id + folder.provider_id`);
        const d4 = await putEmail(originalUnipileId, { folders: [trash.provider_id] });
        if (!d4.ok) {
          console.log("  ABORT: cannot move to trash with any ID combo");
          return;
        }
      }
    }
  }

  // Small delay for the move to propagate
  console.log("\n  Waiting 5s for move to propagate...");
  await sleep(5000);

  // Step E: Verify email left inbox
  step("E", "Verify email is no longer in inbox");
  const inboxCheck = await findEmailInFolder(accountId, inbox.provider_id, subject);
  if (inboxCheck) {
    console.log(`  WARNING: email still found in inbox (id=${inboxCheck.id})`);
  } else {
    console.log("  Confirmed: email not in inbox");
  }

  // Check if email is in trash, and capture its new IDs
  const trashEmail = await findEmailInFolder(accountId, trash.provider_id, subject);
  if (trashEmail) {
    console.log(`  Found in trash: id=${trashEmail.id}, provider_id=${trashEmail.provider_id}`);
    const pidChanged = trashEmail.provider_id !== originalProviderId;
    const uidChanged = trashEmail.id !== originalUnipileId;
    console.log(`  provider_id changed: ${pidChanged}${pidChanged ? ` (${originalProviderId} -> ${trashEmail.provider_id})` : ""}`);
    console.log(`  unipile id changed:  ${uidChanged}${uidChanged ? ` (${originalUnipileId} -> ${trashEmail.id})` : ""}`);
  } else {
    console.log("  Email NOT found in trash either (may need more time)");
  }

  // Step F: KEY TEST -- Undo using the ORIGINAL provider_id (production behavior)
  step("F", "UNDO: Move back to inbox using ORIGINAL provider_id + folder.id (production path)");
  console.log(`  email id: ${originalProviderId}`);
  console.log(`  target folder: ${inbox.id}`);
  const undoRes = await putEmail(originalProviderId, { folders: [inbox.id] }, true);

  if (undoRes.ok) {
    console.log("\n  >> UNDO SUCCEEDED with original provider_id + folder.id");
  } else {
    console.log(`\n  >> UNDO FAILED (status ${undoRes.status}) with original provider_id + folder.id`);
  }

  // Step G: If undo failed, try alternative approaches
  if (!undoRes.ok) {
    step("G", "Try alternative undo approaches");

    // G.1: Original provider_id + folder.provider_id
    console.log("\n  G.1: Original provider_id + folder.provider_id");
    const g1 = await putEmail(originalProviderId, { folders: [inbox.provider_id] }, true);
    if (g1.ok) console.log("  >> G.1 SUCCEEDED");
    else console.log(`  >> G.1 FAILED (${g1.status})`);

    // G.2: Original unipile_id + folder.id
    if (!g1.ok) {
      console.log("\n  G.2: Original unipile_id + folder.id");
      const g2 = await putEmail(originalUnipileId, { folders: [inbox.id] });
      if (g2.ok) console.log("  >> G.2 SUCCEEDED");
      else console.log(`  >> G.2 FAILED (${g2.status})`);
    }

    // G.3: Original unipile_id + folder.provider_id
    console.log("\n  G.3: Original unipile_id + folder.provider_id");
    const g3 = await putEmail(originalUnipileId, { folders: [inbox.provider_id] });
    if (g3.ok) console.log("  >> G.3 SUCCEEDED");
    else console.log(`  >> G.3 FAILED (${g3.status})`);

    // G.4: If email has new IDs in trash, try those
    if (trashEmail && trashEmail.provider_id !== originalProviderId) {
      console.log("\n  G.4: NEW provider_id from trash + folder.id");
      const g4 = await putEmail(trashEmail.provider_id, { folders: [inbox.id] }, true);
      if (g4.ok) console.log("  >> G.4 SUCCEEDED");
      else console.log(`  >> G.4 FAILED (${g4.status})`);

      if (!g4.ok) {
        console.log("\n  G.5: NEW provider_id from trash + folder.provider_id");
        const g5 = await putEmail(trashEmail.provider_id, { folders: [inbox.provider_id] }, true);
        if (g5.ok) console.log("  >> G.5 SUCCEEDED");
        else console.log(`  >> G.5 FAILED (${g5.status})`);
      }
    }

    if (trashEmail && trashEmail.id !== originalUnipileId) {
      console.log("\n  G.6: NEW unipile_id from trash + folder.id");
      const g6 = await putEmail(trashEmail.id, { folders: [inbox.id] });
      if (g6.ok) console.log("  >> G.6 SUCCEEDED");
      else console.log(`  >> G.6 FAILED (${g6.status})`);
    }
  }

  // Step H: Verify email is back in inbox
  step("H", "Final check: poll inbox for email after undo");
  const finalPoll = await pollForEmail(accountId, inbox.provider_id, subject);
  if (finalPoll.found) {
    console.log(`\n  >> FINAL: Email found in inbox after ${finalPoll.attempts} poll(s)`);
    console.log(`    id: ${finalPoll.email.id}`);
    console.log(`    provider_id: ${finalPoll.email.provider_id}`);
    const pidChanged = finalPoll.email.provider_id !== originalProviderId;
    console.log(`    provider_id changed after round-trip: ${pidChanged}`);
  } else {
    console.log("\n  >> FINAL: Email NOT found in inbox after all attempts");
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  // Validate env vars
  if (!API_KEY || !DSN) {
    console.error("Missing UNIPILE_API_KEY or UNIPILE_DSN. See .env.example");
    process.exit(1);
  }

  for (const account of ACCOUNTS) {
    if (!account.accountId || !account.email) {
      console.error(`Missing env vars for ${account.label}. See .env.example`);
      process.exit(1);
    }
  }

  console.log("Unipile Undo Flow Investigation");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`DSN: ${DSN}`);

  for (const account of ACCOUNTS) {
    try {
      await testUndoFlow(account);
    } catch (err) {
      console.error(`\nERROR in ${account.label}: ${err.message}`);
      console.error(err.stack);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("  INVESTIGATION COMPLETE");
  console.log("=".repeat(70));
}

main().catch(console.error);
