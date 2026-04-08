/**
 * Test: Is the Outlook 404 on PUT a timing/sync issue?
 * Send email, find it in inbox, then retry PUT every 5s until it works.
 *
 * Run: node --env-file=.env test-put-timing.mjs
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
  // Resolve folders
  const foldersRes = await api("GET", `/api/v1/folders?account_id=${ACCOUNT_ID}`);
  const inbox = foldersRes.data.items.find(f => f.role === "inbox");
  const trash = foldersRes.data.items.find(f => f.role === "trash");
  const inboxPid = encodeURIComponent(inbox.provider_id);

  // Send email
  const tag = `timing-${Date.now()}`;
  const subject = `[${tag}] PUT timing test`;
  console.log(`Sending: ${subject}`);
  await api("POST", `/api/v1/emails`, {
    account_id: ACCOUNT_ID,
    to: [{ identifier: EMAIL }],
    subject,
    body: "Timing test",
  });

  // Find in inbox
  let email = null;
  for (let i = 0; i < 12; i++) {
    await wait(5000);
    const listRes = await api("GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&limit=10&folder=${inboxPid}`);
    email = listRes.data.items?.find(e => e.subject?.includes(tag));
    if (email) {
      console.log(`Found after ${(i + 1) * 5}s (id: ${email.id})`);
      break;
    }
  }
  if (!email) { console.log("Never found"); return; }

  // Retry PUT every 5s with both id and provider_id
  const foundAt = Date.now();
  for (let i = 0; i < 12; i++) {
    const elapsed = ((Date.now() - foundAt) / 1000).toFixed(1);

    // Try Unipile id
    const putId = await api("PUT", `/api/v1/emails/${email.id}?account_id=${ACCOUNT_ID}`, {
      folders: [inbox.provider_id], // no-op: move to same folder
    });

    // Try provider_id
    const encodedPid = encodeURIComponent(email.provider_id);
    const putPid = await api("PUT", `/api/v1/emails/${encodedPid}?account_id=${ACCOUNT_ID}`, {
      folders: [inbox.provider_id],
    });

    console.log(`${elapsed}s after found: PUT(id)=${putId.status} PUT(provider_id)=${putPid.status}`);

    if (putId.ok && putPid.ok) {
      console.log(`Both work after ${elapsed}s`);
      return;
    }

    await wait(5000);
  }

  console.log("PUT never succeeded within 60s after finding the email");
}

main().catch(console.error);
