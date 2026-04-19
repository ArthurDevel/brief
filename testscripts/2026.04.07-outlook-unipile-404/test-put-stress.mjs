/**
 * Stress test: Send 3 emails, find them, immediately PUT with provider_id.
 * Check if any fail with 404.
 *
 * Run: node --env-file=.env test-put-stress.mjs
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
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const foldersRes = await api("GET", `/api/v1/folders?account_id=${ACCOUNT_ID}`);
  const inbox = foldersRes.data.items.find(f => f.role === "inbox");
  const inboxPid = encodeURIComponent(inbox.provider_id);

  const tag = `stress-${Date.now()}`;
  const subjects = [`${tag}-A`, `${tag}-B`, `${tag}-C`];

  // Send 3 emails
  for (const subj of subjects) {
    await api("POST", `/api/v1/emails`, {
      account_id: ACCOUNT_ID,
      to: [{ identifier: EMAIL }],
      subject: subj,
      body: "stress test",
    });
  }
  console.log("Sent 3 emails");

  // Wait for delivery
  await wait(15000);

  // Find all 3
  const listRes = await api("GET", `/api/v1/emails?account_id=${ACCOUNT_ID}&limit=20&folder=${inboxPid}`);
  const emails = listRes.data.items?.filter(e => e.subject?.includes(tag)) || [];
  console.log(`Found ${emails.length}/3 emails`);

  // Immediately try archive (PUT folders=[]) with provider_id for each
  for (const email of emails) {
    const putRes = await api("PUT", `/api/v1/emails/${email.provider_id}?account_id=${ACCOUNT_ID}`, {
      folders: [],
    });
    console.log(`PUT ${email.subject}: ${putRes.status} ${putRes.ok ? "OK" : JSON.stringify(putRes.data)}`);
  }
}

main().catch(console.error);
