/**
 * Test: Can we PUT (move) a freshly sent Outlook email immediately after it appears in listInbox?
 * This reproduces the e2e test flow: send -> wait -> find in inbox -> try to move.
 *
 * Run: node --env-file=.env test-fresh-email-put.mjs
 */

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN = process.env.UNIPILE_DSN;
const ACCOUNT_ID = process.env.TEST_OUTLOOK_UNIPILE_ACCOUNT_ID;
const EMAIL = process.env.TEST_OUTLOOK_UNIPILE_EMAIL;

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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Step 1: Resolve inbox
  const foldersRes = await api("GET", `/api/v1/folders?account_id=${ACCOUNT_ID}`);
  const inbox = foldersRes.data.items.find(f => f.role === "inbox");
  const trash = foldersRes.data.items.find(f => f.role === "trash");
  console.log("Inbox provider_id:", inbox.provider_id);
  console.log("Trash provider_id:", trash.provider_id);

  // Step 2: Send an email to self
  const tag = `test-put-${Date.now()}`;
  const subject = `[${tag}] Fresh email PUT test`;
  console.log(`\nSending email: ${subject}`);
  const sendRes = await api("POST", `/api/v1/emails`, {
    account_id: ACCOUNT_ID,
    to: [{ identifier: EMAIL }],
    subject,
    body: "Testing PUT on fresh email",
  });
  console.log("Send result:", sendRes.status, sendRes.ok);

  // Step 3: Poll until it appears in inbox
  const inboxPid = encodeURIComponent(inbox.provider_id);
  let email = null;
  for (let i = 0; i < 12; i++) {
    await wait(5000);
    const listRes = await api("GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&limit=10&folder=${inboxPid}`);
    email = listRes.data.items?.find(e => e.subject?.includes(tag));
    if (email) {
      console.log(`\nFound email after ${(i + 1) * 5}s`);
      console.log("  id:", email.id);
      console.log("  provider_id:", email.provider_id);
      break;
    }
    console.log(`  Not found yet (${(i + 1) * 5}s)`);
  }

  if (!email) {
    console.log("Email never appeared in inbox");
    return;
  }

  // Step 4: Immediately try PUT with Unipile id
  console.log(`\nAttempting PUT with Unipile id: ${email.id}`);
  const putIdRes = await api("PUT", `/api/v1/emails/${email.id}?account_id=${ACCOUNT_ID}`, {
    folders: [trash.provider_id],
  });
  console.log("PUT by id:", putIdRes.status, putIdRes.ok, JSON.stringify(putIdRes.data));

  // Step 5: If that failed, try PUT with provider_id
  if (!putIdRes.ok) {
    console.log(`\nAttempting PUT with provider_id: ${email.provider_id}`);
    const encodedPid = encodeURIComponent(email.provider_id);
    const putPidRes = await api("PUT", `/api/v1/emails/${encodedPid}?account_id=${ACCOUNT_ID}`, {
      folders: [trash.provider_id],
    });
    console.log("PUT by provider_id:", putPidRes.status, putPidRes.ok, JSON.stringify(putPidRes.data));
  }

  // Step 6: Also check -- what does our codebase use as the email ID?
  // mapToEmailSummary uses: String(item.provider_id ?? item.id ?? "")
  const codebaseId = String(email.provider_id ?? email.id ?? "");
  console.log(`\nCodebase would use ID: ${codebaseId}`);
  console.log(`This is the ${codebaseId === email.id ? 'Unipile id' : 'provider_id'}`);

  if (codebaseId !== email.id) {
    console.log(`\nAttempting PUT with codebase ID (provider_id): ${codebaseId}`);
    const encodedCodebaseId = encodeURIComponent(codebaseId);
    const putCodebaseRes = await api("PUT", `/api/v1/emails/${encodedCodebaseId}?account_id=${ACCOUNT_ID}`, {
      folders: [trash.provider_id],
    });
    console.log("PUT by codebase ID:", putCodebaseRes.status, putCodebaseRes.ok, JSON.stringify(putCodebaseRes.data));
  }
}

main().catch(console.error);
