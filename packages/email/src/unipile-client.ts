/**
 * Unipile-backed email client operations.
 *
 * Implements email operations (list, read, search, archive, delete, move,
 * draft, send, reply, folders) via the Unipile REST API. Each method takes
 * a Unipile account ID as the first parameter.
 *
 * Responsibilities:
 * - List and search inbox emails via Unipile
 * - Read full email content and threads
 * - Archive, delete, and move emails
 * - Send emails and replies
 * - Save and delete drafts
 * - List folders and resolve special-use folders
 * - Fetch reply context and email metadata batches
 */

import type {
  EmailSummary,
  Email,
  ThreadMessage,
  EmailMeta,
  EmailMetaRequest,
  FolderInfo,
  ReplyContext,
} from "./types";
import type { UndoRecipe } from "@dublin/tools/src/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const UNIPILE_DSN = process.env.UNIPILE_DSN;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists recent emails in the inbox via Unipile.
 * @param accountId - Unipile account ID
 * @param limit - Maximum number of emails to return
 * @returns Array of email summaries
 */
export async function listInbox(accountId: string, limit: number): Promise<EmailSummary[]> {
  const data = await unipileGet(`/api/v1/emails?account_id=${accountId}&limit=${limit}`);
  const items = data.items ?? data ?? [];
  return items.map(mapToEmailSummary);
}

/**
 * Searches emails by query string via Unipile.
 * @param accountId - Unipile account ID
 * @param query - Search query string
 * @returns Array of matching email summaries
 */
export async function searchEmails(accountId: string, query: string): Promise<EmailSummary[]> {
  const encoded = encodeURIComponent(query);
  const data = await unipileGet(`/api/v1/emails?account_id=${accountId}&q=${encoded}`);
  const items = data.items ?? data ?? [];
  return items.map(mapToEmailSummary);
}

/**
 * Reads the full content of an email by Unipile email ID.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @returns Full email content
 */
export async function readEmail(accountId: string, emailId: string): Promise<Email> {
  const data = await unipileGet(`/api/v1/emails/${emailId}?account_id=${accountId}`);
  return mapToEmail(data);
}

/**
 * Reads all messages in a thread via Unipile.
 * There is no dedicated thread endpoint. First fetches the email to get its
 * thread_id, then lists all emails with that thread_id.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID of any message in the thread
 * @returns Array of thread messages in chronological order
 */
export async function readThread(accountId: string, emailId: string): Promise<ThreadMessage[]> {
  // Step 1: Fetch the email to get its thread_id
  const email = await unipileGet(`/api/v1/emails/${emailId}?account_id=${accountId}`);
  const threadId = email.thread_id;
  if (!threadId) {
    // Single-message thread -- just return this email
    return [mapToThreadMessage(email)];
  }

  // Step 2: List all emails in this thread
  const data = await unipileGet(`/api/v1/emails?account_id=${accountId}&thread_id=${threadId}`);
  const items = data.items ?? data ?? [];

  const messages: ThreadMessage[] = items.map(mapToThreadMessage);
  messages.sort((a: ThreadMessage, b: ThreadMessage) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return messages;
}

/**
 * Marks an email as read via Unipile.
 * Unipile expects { unread: false } to mark as read.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 */
export async function markAsRead(accountId: string, emailId: string): Promise<void> {
  await unipilePut(`/api/v1/emails/${emailId}?account_id=${accountId}`, { unread: false });
}

/**
 * Archives an email via Unipile by removing it from INBOX.
 * Unipile uses { folders: ["LABEL"] } as an array of strings.
 * Archiving means setting folders to exclude INBOX.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @param sourceFolder - The folder the email is currently in (for undo)
 * @returns UndoRecipe to reverse the archive
 */
export async function archiveEmail(
  accountId: string,
  emailId: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  // Unipile: setting folders to empty array or a non-INBOX label removes from INBOX
  await unipilePut(`/api/v1/emails/${emailId}?account_id=${accountId}`, {
    folders: [],
  });

  return {
    operation: "move_email",
    params: {
      emailId,
      from: "ARCHIVE",
      to: sourceFolder,
    },
  };
}

/**
 * Deletes an email via Unipile by moving it to the trash folder.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @param sourceFolder - The folder the email is currently in (for undo)
 * @returns UndoRecipe to reverse the deletion
 */
export async function deleteEmail(
  accountId: string,
  emailId: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  await unipilePut(`/api/v1/emails/${emailId}?account_id=${accountId}`, {
    folders: ["TRASH"],
  });

  return {
    operation: "move_email",
    params: {
      emailId,
      from: "TRASH",
      to: sourceFolder,
    },
  };
}

/**
 * Moves an email to a target folder via Unipile.
 * Unipile expects { folders: ["LABEL_NAME"] } as an array of strings.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @param targetFolder - Destination folder
 * @param sourceFolder - Source folder (for undo)
 * @returns UndoRecipe to reverse the move
 */
export async function moveToFolder(
  accountId: string,
  emailId: string,
  targetFolder: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  await unipilePut(`/api/v1/emails/${emailId}?account_id=${accountId}`, {
    folders: [targetFolder],
  });

  return {
    operation: "move_email",
    params: {
      emailId,
      from: targetFolder,
      to: sourceFolder,
    },
  };
}

/**
 * Moves an email between folders via Unipile. Used by undo operations.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @param from - Source folder (unused -- Unipile replaces all folders)
 * @param to - Destination folder
 */
export async function moveEmail(
  accountId: string,
  emailId: string,
  from: string,
  to: string
): Promise<void> {
  await unipilePut(`/api/v1/emails/${emailId}?account_id=${accountId}`, {
    folders: [to],
  });
}

/**
 * Lists all folders for a Unipile account.
 * @param accountId - Unipile account ID
 * @returns Array of folder info objects
 */
export async function listFolders(accountId: string): Promise<FolderInfo[]> {
  const data = await unipileGet(`/api/v1/folders?account_id=${accountId}`);
  const items = data.items ?? data ?? [];

  return items
    .filter((f: any) => f.name !== "INBOX")
    .map((f: any) => ({
      path: (f.id as string) ?? (f.name as string),
      name: f.name as string,
      specialUse: mapUnipileRole(f.role as string | undefined),
    }));
}

/**
 * Resolves a special-use folder by flag via Unipile folder listing.
 * @param accountId - Unipile account ID
 * @param flag - RFC 6154 special-use flag (e.g. "\\Trash")
 * @returns Folder path/ID, or null if not found
 */
export async function resolveSpecialUseFolder(
  accountId: string,
  flag: string
): Promise<string | null> {
  const folders = await listFolders(accountId);
  const match = folders.find((f) => f.specialUse === flag);
  return match?.path ?? null;
}

/**
 * Saves a draft email via Unipile.
 * Drafts go through POST /api/v1/drafts (NOT /api/v1/emails with draft: true,
 * which silently sends the email instead).
 * @param accountId - Unipile account ID
 * @param params - Draft parameters
 * @returns UndoRecipe to delete the created draft
 */
export async function saveDraft(
  accountId: string,
  params: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string }
): Promise<UndoRecipe> {
  const payload: Record<string, unknown> = {
    account_id: accountId,
    to: [{ display_name: "", identifier: params.to }],
    subject: params.subject,
    body: params.body,
  };

  if (params.cc) {
    payload.cc = params.cc.split(",").map((addr: string) => ({ display_name: "", identifier: addr.trim() }));
  }
  if (params.inReplyTo) {
    // reply_to must be the provider_id of the parent email
    payload.reply_to = params.inReplyTo;
  }

  const data = await unipilePost("/api/v1/drafts", payload);
  // POST /api/v1/drafts returns { object: "DraftCreated", draft_id: "..." }
  const draftId = data.draft_id ?? data.id ?? data.email_id ?? "unknown";

  return {
    operation: "delete_draft",
    params: { draftUid: String(draftId) },
  };
}

/**
 * Deletes a draft by ID via Unipile.
 * @param accountId - Unipile account ID
 * @param draftId - The draft email ID
 */
export async function deleteDraft(accountId: string, draftId: string): Promise<void> {
  await unipileDelete(`/api/v1/emails/${draftId}?account_id=${accountId}`);
}

/**
 * Sends an email via Unipile.
 * The "to" field must be an array of { display_name, identifier } objects.
 * @param accountId - Unipile account ID
 * @param params - Email parameters (to, subject, body)
 */
export async function sendEmail(
  accountId: string,
  params: { to: string; subject: string; body: string }
): Promise<void> {
  await unipilePost("/api/v1/emails", {
    account_id: accountId,
    to: [{ display_name: "", identifier: params.to }],
    subject: params.subject,
    body: params.body,
  });
}

/**
 * Sends a reply to an existing email via Unipile.
 * There is no dedicated reply endpoint. Replies go through POST /api/v1/emails
 * with reply_to set to the provider_id of the parent email.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID to reply to
 * @param body - Reply body text
 * @param replyAll - Whether to reply to all recipients
 * @param senderAddress - The sender's email address
 */
export async function replyEmail(
  accountId: string,
  emailId: string,
  body: string,
  replyAll: boolean,
  senderAddress: string
): Promise<void> {
  // Step 1: Fetch the original email to get provider_id and recipients
  const original = await unipileGet(`/api/v1/emails/${emailId}?account_id=${accountId}`);
  const providerId = original.provider_id;
  if (!providerId) {
    throw new Error(`Email ${emailId} has no provider_id -- cannot reply`);
  }

  // Step 2: Build recipient lists from the original email
  const originalFrom = original.from_attendee;
  const originalTo = original.to_attendees ?? [];
  const originalCc = original.cc_attendees ?? [];
  const originalSubject = (original.subject as string) ?? "(no subject)";

  // Reply goes to the original sender
  const toRecipients = [{ display_name: originalFrom?.display_name ?? "", identifier: originalFrom?.identifier ?? "" }];

  const payload: Record<string, unknown> = {
    account_id: accountId,
    reply_to: providerId,
    subject: originalSubject.startsWith("Re: ") ? originalSubject : `Re: ${originalSubject}`,
    body,
    to: toRecipients,
  };

  // For reply-all, add original To and CC (excluding self)
  if (replyAll) {
    const allCc: Array<{ display_name: string; identifier: string }> = [];
    for (const attendee of [...originalTo, ...originalCc]) {
      const addr = attendee.identifier ?? "";
      if (addr && addr !== senderAddress && addr !== originalFrom?.identifier) {
        allCc.push({ display_name: attendee.display_name ?? "", identifier: addr });
      }
    }
    if (allCc.length > 0) {
      payload.cc = allCc;
    }
  }

  await unipilePost("/api/v1/emails", payload);
}

/**
 * Fetches reply context for an email via Unipile.
 * Uses from_attendee, to_attendees, cc_attendees fields from the Unipile response.
 * The messageId is the RFC message_id, and provider_id is stored for reply_to usage.
 * @param accountId - Unipile account ID
 * @param emailId - The Unipile email ID
 * @returns ReplyContext with threading and recipient info
 */
export async function fetchReplyContext(accountId: string, emailId: string): Promise<ReplyContext> {
  const data = await unipileGet(`/api/v1/emails/${emailId}?account_id=${accountId}`);

  // provider_id is needed for reply_to in Unipile. We store it as messageId
  // since that field is used by the caller to set reply_to.
  const messageId = (data.provider_id as string) ?? (data.message_id as string) ?? (data.id as string);
  const references = extractReferencesFromData(data);
  const from = extractAttendeeAddress(data.from_attendee);
  const to = extractAttendeesAddresses(data.to_attendees);
  const cc = extractAttendeesAddresses(data.cc_attendees);
  const subject = (data.subject as string) ?? "(no subject)";

  return { messageId, references, from, to, cc, subject };
}

/**
 * Fetches email metadata (subject, from) for a batch of requests via Unipile.
 * Uses from_attendee field for the sender address.
 * @param accountId - Unipile account ID
 * @param requests - Array of lookup requests
 * @returns Map of actionId to EmailMeta
 */
export async function fetchEmailMetaBatch(
  accountId: string,
  requests: EmailMetaRequest[]
): Promise<Map<string, EmailMeta>> {
  const results = new Map<string, EmailMeta>();

  // Fetch each email individually -- Unipile does not have a batch endpoint
  for (const req of requests) {
    const lookupId = req.messageId ?? req.uid;
    if (!lookupId) continue;

    try {
      const emailData = await unipileGet(`/api/v1/emails/${lookupId}?account_id=${accountId}`);
      results.set(req.actionId, {
        subject: (emailData.subject as string) ?? "(no subject)",
        from: formatAttendee(emailData.from_attendee),
      });
    } catch (err) {
      console.warn(`[fetchEmailMetaBatch] Failed to fetch email ${lookupId}:`, err);
    }
  }

  return results;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the Unipile API base URL.
 * @returns Base URL string
 */
function getBaseUrl(): string {
  if (!UNIPILE_DSN) {
    throw new Error("UNIPILE_DSN environment variable is not set");
  }
  return UNIPILE_DSN;
}

/**
 * Returns the Unipile API key.
 * @returns API key string
 */
function getApiKey(): string {
  if (!UNIPILE_API_KEY) {
    throw new Error("UNIPILE_API_KEY environment variable is not set");
  }
  return UNIPILE_API_KEY;
}

/**
 * Builds standard headers for Unipile API requests.
 * Uses X-API-KEY header (not Authorization: Bearer).
 * @returns Headers object
 */
function buildHeaders(includeContentType: boolean = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-KEY": getApiKey(),
    "Accept": "application/json",
  };
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Makes a GET request to the Unipile API.
 * @param path - API path (e.g. "/api/v1/emails?account_id=abc")
 * @returns Parsed JSON response
 */
async function unipileGet(path: string): Promise<any> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unipile GET ${path} failed (${res.status}): ${body}`);
  }

  return await res.json();
}

/**
 * Makes a PUT request to the Unipile API.
 * @param path - API path
 * @param body - Request body
 * @returns Parsed JSON response
 */
async function unipilePut(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "PUT",
    headers: buildHeaders(true),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unipile PUT ${path} failed (${res.status}): ${text}`);
  }

  return await res.json();
}

/**
 * Makes a POST request to the Unipile API.
 * @param path - API path
 * @param body - Request body
 * @returns Parsed JSON response
 */
async function unipilePost(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: buildHeaders(true),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unipile POST ${path} failed (${res.status}): ${text}`);
  }

  return await res.json();
}

/**
 * Makes a DELETE request to the Unipile API.
 * @param path - API path
 * @returns Parsed JSON response
 */
async function unipileDelete(path: string): Promise<any> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unipile DELETE ${path} failed (${res.status}): ${text}`);
  }

  // Some DELETE endpoints return empty body
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Maps a Unipile email response to an EmailSummary.
 * Uses from_attendee.identifier for sender and body_plain for snippet.
 * @param item - Raw Unipile email object
 * @returns Mapped EmailSummary
 */
function mapToEmailSummary(item: any): EmailSummary {
  return {
    id: String(item.provider_id ?? item.id ?? ""),
    from: formatAttendee(item.from_attendee),
    subject: (item.subject as string) ?? "(no subject)",
    snippet: ((item.body_plain as string) ?? "").substring(0, 100),
    date: (item.date as string) ?? "",
  };
}

/**
 * Maps a Unipile email response to a full Email.
 * Uses from_attendee for sender, to_attendees for recipients, read_date for read status.
 * @param item - Raw Unipile email object
 * @returns Mapped Email
 */
function mapToEmail(item: any): Email {
  return {
    id: String(item.provider_id ?? item.id ?? ""),
    from: formatAttendee(item.from_attendee),
    to: formatAttendees(item.to_attendees),
    subject: (item.subject as string) ?? "(no subject)",
    body: (item.body as string) ?? (item.body_plain as string) ?? "",
    date: (item.date as string) ?? "",
    isRead: item.read_date != null,
  };
}

/**
 * Maps a Unipile email response to a ThreadMessage.
 * @param item - Raw Unipile email object
 * @returns Mapped ThreadMessage
 */
function mapToThreadMessage(item: any): ThreadMessage {
  return {
    id: String(item.id ?? ""),
    from: formatAttendee(item.from_attendee),
    to: formatAttendees(item.to_attendees),
    subject: (item.subject as string) ?? "(no subject)",
    body: (item.body as string) ?? (item.body_plain as string) ?? "",
    date: (item.date as string) ?? "",
  };
}

/**
 * Formats a single Unipile attendee object as "Name <email>" or just "email".
 * @param attendee - Unipile attendee object (e.g. from_attendee)
 * @returns Formatted address string
 */
function formatAttendee(attendee: any): string {
  if (!attendee) return "(unknown)";
  const name = (attendee.display_name ?? "") as string;
  const addr = (attendee.identifier ?? "") as string;
  if (!addr) return "(unknown)";
  return name ? `${name} <${addr}>` : addr;
}

/**
 * Formats an array of Unipile attendee objects as a comma-separated string.
 * @param attendees - Array of attendee objects (e.g. to_attendees)
 * @returns Formatted address string
 */
function formatAttendees(attendees: any): string {
  if (!attendees || !Array.isArray(attendees) || attendees.length === 0) return "(unknown)";
  return attendees.map(formatAttendee).join(", ");
}

/**
 * Extracts a single raw email address from a Unipile attendee object.
 * @param attendee - The attendee object (e.g. from_attendee)
 * @returns Raw email address string
 */
function extractAttendeeAddress(attendee: any): string {
  if (!attendee) return "";
  return (attendee.identifier ?? "") as string;
}

/**
 * Extracts all raw email addresses from a Unipile attendees array.
 * @param attendees - Array of attendee objects (e.g. to_attendees)
 * @returns Array of raw email address strings
 */
function extractAttendeesAddresses(attendees: any): string[] {
  if (!attendees || !Array.isArray(attendees)) return [];
  return attendees
    .map((a: any) => (a.identifier ?? "") as string)
    .filter(Boolean);
}

/**
 * Extracts References message IDs from Unipile email data.
 * @param data - Raw Unipile email response
 * @returns Array of message ID strings
 */
function extractReferencesFromData(data: Record<string, unknown>): string[] {
  const refs = data.references;
  if (!refs) return [];
  if (typeof refs === "string") {
    return refs.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(refs)) {
    return refs.map(String);
  }
  return [];
}

/**
 * Maps a Unipile folder role to an RFC 6154 special-use flag.
 * @param role - Unipile folder role string
 * @returns RFC 6154 flag or null
 */
function mapUnipileRole(role: string | undefined): string | null {
  if (!role) return null;
  const lower = role.toLowerCase();
  if (lower === "trash") return "\\Trash";
  if (lower === "drafts" || lower === "draft") return "\\Drafts";
  if (lower === "sent") return "\\Sent";
  if (lower === "all" || lower === "archive") return "\\All";
  if (lower === "spam" || lower === "junk") return "\\Junk";
  return null;
}
