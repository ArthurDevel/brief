/**
 * IMAP client operations for email management.
 *
 * Wraps ImapFlow to provide high-level email operations: listing,
 * searching, reading, marking, archiving, deleting, and moving emails.
 * Includes connection management with auto-reconnect.
 *
 * Responsibilities:
 * - Create and close IMAP connections
 * - List and search inbox emails
 * - Read full email content by UID
 * - Mark emails as read
 * - Archive and delete emails (with undo recipes)
 * - Move emails between folders (used by undo)
 * - Auto-reconnect wrapper for connection failures
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import TurndownService from "turndown";
import type { ImapConfig, EmailSummary, Email, ThreadMessage, EmailMeta, EmailMetaRequest, FolderInfo, ReplyContext } from "./types";
import type { UndoRecipe } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

const SNIPPET_LENGTH = 100;

// ============================================================================
// FOLDER DISCOVERY
// ============================================================================

/**
 * Discovers IMAP folder paths by their SPECIAL-USE flags (RFC 6154).
 * Gmail may use "[Gmail]/..." or "[Google Mail]/..." or localized names.
 * This resolves the actual paths at runtime.
 */
export async function resolveSpecialUseFolder(
  client: ImapFlow,
  flag: "\\All" | "\\Trash" | "\\Drafts" | "\\Sent"
): Promise<string> {
  const mailboxes = await client.list();
  for (const mailbox of mailboxes) {
    if (mailbox.specialUse === flag) {
      return mailbox.path;
    }
  }
  throw new Error(`No mailbox with special-use flag ${flag} found`);
}

/**
 * Lists all selectable IMAP folders, excluding INBOX and non-selectable parents.
 * @param client - Connected ImapFlow client
 * @returns Array of folder info objects
 */
export async function listFolders(client: ImapFlow): Promise<FolderInfo[]> {
  const mailboxes = await client.list();
  const folders: FolderInfo[] = [];

  for (const mailbox of mailboxes) {
    // Skip non-selectable folders (e.g. [Gmail] container)
    if (mailbox.flags && mailbox.flags.has("\\Noselect")) continue;
    // Skip INBOX -- user is already there
    if (mailbox.path === "INBOX") continue;

    const pathSegments = mailbox.path.split(mailbox.delimiter || "/");
    const name = pathSegments[pathSegments.length - 1];

    folders.push({
      path: mailbox.path,
      name,
      specialUse: mailbox.specialUse ?? null,
    });
  }

  return folders;
}

/**
 * Moves an email to a target folder and returns an undo recipe.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to move
 * @param targetFolder - Destination folder path
 * @param sourceFolder - Current folder path (for undo)
 * @returns UndoRecipe to reverse the move
 */
export async function moveEmailToFolder(
  client: ImapFlow,
  emailId: string,
  targetFolder: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  const lock = await client.getMailboxLock(sourceFolder);

  try {
    // Fetch the stable Message-ID before moving (UIDs change across folders)
    const msg = await client.fetchOne(emailId, { envelope: true }, { uid: true });
    if (!msg || !msg.envelope) throw new Error(`Email with UID ${emailId} not found`);
    const messageId = msg.envelope.messageId;
    if (!messageId) throw new Error("Email has no Message-ID header");

    await client.messageMove(emailId, targetFolder, { uid: true });

    return {
      operation: "move_email",
      params: {
        messageId,
        from: targetFolder,
        to: sourceFolder,
      },
    };
  } finally {
    lock.release();
  }
}

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

/**
 * Creates and connects an ImapFlow client with IDLE keepalive.
 * @param config - IMAP server connection parameters
 * @returns Connected ImapFlow client instance
 */
export async function createImapConnection(config: ImapConfig): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure ?? true,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  });

  await client.connect();

  return client;
}

/**
 * Gracefully closes an IMAP connection.
 * @param client - The ImapFlow client to close
 */
export async function closeImapConnection(client: ImapFlow): Promise<void> {
  await client.logout();
}

/**
 * Wraps an IMAP operation with auto-reconnect on connection failure.
 * Retries once with a fresh connection if the original fails.
 * @param client - The ImapFlow client to use
 * @param config - IMAP config for reconnection
 * @param operation - The async operation to execute
 * @returns The result of the operation
 */
export async function withReconnect<T>(
  client: ImapFlow,
  config: ImapConfig,
  operation: (client: ImapFlow) => Promise<T>
): Promise<T> {
  try {
    return await operation(client);
  } catch (error) {
    // Retry once with a fresh connection
    const freshClient = await createImapConnection(config);
    return await operation(freshClient);
  }
}

// ============================================================================
// EMAIL OPERATIONS
// ============================================================================

/**
 * Lists recent emails in the inbox.
 * @param client - Connected ImapFlow client
 * @param limit - Maximum number of emails to return
 * @returns Array of email summaries
 */
export async function listInbox(client: ImapFlow, limit: number): Promise<EmailSummary[]> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      return [];
    }

    const totalMessages = mailbox.exists;
    const startSeq = Math.max(1, totalMessages - limit + 1);
    const range = `${startSeq}:*`;

    // Collect metadata first (cannot run other IMAP commands inside fetch loop)
    const pending: Array<{ uid: number; envelope: any; bodyStructure: any }> = [];
    for await (const message of client.fetch(range, {
      envelope: true,
      bodyStructure: true,
    })) {
      if (message.envelope) {
        pending.push({
          uid: message.uid,
          envelope: message.envelope,
          bodyStructure: message.bodyStructure,
        });
      }
    }

    // Fetch text parts and build summaries
    const messages: EmailSummary[] = [];
    for (const { uid, envelope, bodyStructure } of pending) {
      const snippet = await extractSnippetFromStructure(client, uid, bodyStructure);
      messages.push({
        id: String(uid),
        from: formatAddress(envelope.from),
        subject: envelope.subject ?? "(no subject)",
        snippet,
        date: envelope.date?.toISOString() ?? "",
      });
    }

    messages.reverse();
    return messages;
  } finally {
    lock.release();
  }
}

/**
 * Searches emails by query string (subject, sender, date range).
 * @param client - Connected ImapFlow client
 * @param query - Search query string
 * @returns Array of matching email summaries
 */
export async function searchEmails(client: ImapFlow, query: string): Promise<EmailSummary[]> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    const searchResult = await client.search({
      or: [{ subject: query }, { from: query }],
    });

    if (!searchResult || searchResult.length === 0) {
      return [];
    }

    // Collect metadata first (cannot run other IMAP commands inside fetch loop)
    const pending: Array<{ uid: number; envelope: any; bodyStructure: any }> = [];
    const uidSet = searchResult.map(String).join(",");

    for await (const message of client.fetch(uidSet, {
      envelope: true,
      uid: true,
      bodyStructure: true,
    })) {
      if (message.envelope) {
        pending.push({
          uid: message.uid,
          envelope: message.envelope,
          bodyStructure: message.bodyStructure,
        });
      }
    }

    // Fetch text parts and build summaries
    const messages: EmailSummary[] = [];
    for (const { uid, envelope, bodyStructure } of pending) {
      const snippet = await extractSnippetFromStructure(client, uid, bodyStructure);
      messages.push({
        id: String(uid),
        from: formatAddress(envelope.from),
        subject: envelope.subject ?? "(no subject)",
        snippet,
        date: envelope.date?.toISOString() ?? "",
      });
    }

    messages.reverse();
    return messages;
  } finally {
    lock.release();
  }
}

/**
 * Reads the full content of an email by UID.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to read
 * @returns Full email content
 */
export async function readEmail(client: ImapFlow, emailId: string): Promise<Email> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    const uid = Number(emailId);
    const message = await client.fetchOne(String(uid), {
      envelope: true,
      flags: true,
      source: true,
    }, { uid: true });

    if (!message) {
      throw new Error(`Email with UID ${emailId} not found`);
    }

    if (!message.envelope) {
      throw new Error(`Email with UID ${emailId} has no envelope data`);
    }

    const envelope = message.envelope;
    const sourceBuffer = message.source ?? Buffer.from("");
    const body = await extractBodyFromMime(sourceBuffer);
    const flags = message.flags ?? new Set<string>();

    return {
      id: String(message.uid),
      from: formatAddress(envelope.from),
      to: formatAddress(envelope.to),
      subject: envelope.subject ?? "(no subject)",
      body,
      date: envelope.date?.toISOString() ?? "",
      isRead: flags.has("\\Seen"),
    };
  } finally {
    lock.release();
  }
}

/**
 * Reads all messages in a thread by following Message-Id / References headers.
 * Searches [Gmail]/All Mail to include both sent and received messages.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of any email in the thread (from INBOX)
 * @returns Array of thread messages in chronological order
 */
export async function readThread(client: ImapFlow, emailId: string): Promise<ThreadMessage[]> {
  // Step 1: Read the target email from INBOX to get its headers
  const inboxLock = await client.getMailboxLock("INBOX");
  let messageId: string | undefined;
  let references: string[] = [];

  try {
    const message = await client.fetchOne(String(Number(emailId)), {
      envelope: true,
      source: true,
    }, { uid: true });

    if (!message || !message.envelope) {
      throw new Error(`Email with UID ${emailId} not found`);
    }

    messageId = message.envelope.messageId;
    const sourceText = message.source?.toString("utf-8") ?? "";
    references = extractReferences(sourceText);
  } finally {
    inboxLock.release();
  }

  // Collect all known Message-IDs for this thread
  const threadIds = new Set<string>();
  if (messageId) threadIds.add(messageId);
  for (const ref of references) threadIds.add(ref);

  // Step 2: Search All Mail by HEADER for each thread Message-ID
  const allMailFolder = await resolveSpecialUseFolder(client, "\\All");
  const allMailLock = await client.getMailboxLock(allMailFolder);
  try {
    const matchedUids = new Set<number>();

    for (const id of threadIds) {
      // Find messages with this Message-ID
      const byId = await client.search({ header: { "message-id": id } });
      if (byId) for (const uid of byId) matchedUids.add(uid);

      // Find messages that reference this Message-ID
      // Search both References and In-Reply-To headers because Gmail does not
      // support IMAP HEADER search on References (returns 0 results).
      const byRef = await client.search({ header: { references: id } });
      if (byRef) for (const uid of byRef) matchedUids.add(uid);

      const byInReplyTo = await client.search({ header: { "in-reply-to": id } });
      if (byInReplyTo) for (const uid of byInReplyTo) matchedUids.add(uid);
    }

    if (matchedUids.size === 0) {
      throw new Error(`No thread messages found for email ${emailId}`);
    }

    // Fetch only the matched messages (search returns sequence numbers)
    const seqSet = [...matchedUids].join(",");
    const results: ThreadMessage[] = [];

    for await (const msg of client.fetch(seqSet, {
      envelope: true,
      source: true,
    })) {
      if (!msg.envelope) continue;

      const sourceBuffer = msg.source ?? Buffer.from("");
      const body = await extractBodyFromMime(sourceBuffer);

      results.push({
        id: String(msg.uid),
        from: formatAddress(msg.envelope.from),
        to: formatAddress(msg.envelope.to),
        subject: msg.envelope.subject ?? "(no subject)",
        body,
        date: msg.envelope.date?.toISOString() ?? "",
      });
    }

    results.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return results;
  } finally {
    allMailLock.release();
  }
}

/**
 * Fetches the envelope and headers needed to build a properly threaded reply.
 * Extracts Message-ID, References, From, all To addresses, all CC addresses,
 * and the Subject from an email in INBOX.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to fetch context for
 * @returns ReplyContext with threading and recipient info
 */
export async function fetchReplyContext(client: ImapFlow, emailId: string): Promise<ReplyContext> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    const uid = Number(emailId);
    const message = await client.fetchOne(String(uid), {
      envelope: true,
      source: true,
    }, { uid: true });

    if (!message || !message.envelope) {
      throw new Error(`Email with UID ${emailId} not found`);
    }

    const envelope = message.envelope;

    // Message-ID is required for threading
    const messageId = envelope.messageId;
    if (!messageId) {
      throw new Error(`Email with UID ${emailId} has no Message-ID header`);
    }

    // Parse References from raw headers
    const sourceText = message.source?.toString("utf-8") ?? "";
    const references = extractReferences(sourceText);

    // Extract raw email address from the first From entry
    const from = extractEmailAddress(envelope.from);

    // Extract ALL To and CC addresses (not just the first one)
    const to = extractAllEmailAddresses(envelope.to);
    const cc = extractAllEmailAddresses(envelope.cc);

    const subject = envelope.subject ?? "(no subject)";

    return { messageId, references, from, to, cc, subject };
  } finally {
    lock.release();
  }
}

/**
 * Marks an email as read (sets the \Seen flag).
 * Not undoable -- returns null.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to mark
 * @returns null (not undoable)
 */
export async function markAsRead(client: ImapFlow, emailId: string): Promise<null> {
  const lock = await client.getMailboxLock("INBOX");

  try {
    await client.messageFlagsAdd(emailId, ["\\Seen"], { uid: true });
    return null;
  } finally {
    lock.release();
  }
}

/**
 * Archives an email by moving it to the Archive/All Mail folder.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to archive
 * @param sourceFolder - The folder the email is currently in (for undo)
 * @returns UndoRecipe to reverse the archive operation
 */
export async function archiveEmail(
  client: ImapFlow,
  emailId: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  const archiveFolder = await resolveSpecialUseFolder(client, "\\All");
  const lock = await client.getMailboxLock(sourceFolder);

  try {
    // Fetch the stable Message-ID before moving (UIDs change across folders)
    const msg = await client.fetchOne(emailId, { envelope: true }, { uid: true });
    if (!msg || !msg.envelope) throw new Error(`Email with UID ${emailId} not found`);
    const messageId = msg.envelope.messageId;
    if (!messageId) throw new Error("Email has no Message-ID header");

    await client.messageMove(emailId, archiveFolder, { uid: true });

    return {
      operation: "move_email",
      params: {
        messageId,
        from: archiveFolder,
        to: sourceFolder,
      },
    };
  } finally {
    lock.release();
  }
}

/**
 * Deletes an email by moving it to the Trash folder.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to delete
 * @param sourceFolder - The folder the email is currently in (for undo)
 * @returns UndoRecipe to reverse the delete operation
 */
export async function deleteEmail(
  client: ImapFlow,
  emailId: string,
  sourceFolder: string
): Promise<UndoRecipe> {
  const trashFolder = await resolveSpecialUseFolder(client, "\\Trash");
  const lock = await client.getMailboxLock(sourceFolder);

  try {
    // Fetch the stable Message-ID before moving (UIDs change across folders)
    const msg = await client.fetchOne(emailId, { envelope: true }, { uid: true });
    if (!msg || !msg.envelope) throw new Error(`Email with UID ${emailId} not found`);
    const messageId = msg.envelope.messageId;
    if (!messageId) throw new Error("Email has no Message-ID header");

    await client.messageMove(emailId, trashFolder, { uid: true });

    return {
      operation: "move_email",
      params: {
        messageId,
        from: trashFolder,
        to: sourceFolder,
      },
    };
  } finally {
    lock.release();
  }
}

/**
 * Moves an email between IMAP folders. Used by undo to reverse archive/delete.
 * Looks up the email by Message-ID header (stable across folders) instead of UID.
 * @param client - Connected ImapFlow client
 * @param messageId - The Message-ID header value
 * @param from - Source folder
 * @param to - Destination folder
 */
export async function moveEmail(
  client: ImapFlow,
  messageId: string,
  from: string,
  to: string
): Promise<void> {
  const lock = await client.getMailboxLock(from);

  try {
    // Find the current UID by searching for the Message-ID header
    const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
    if (!uids || uids.length === 0) {
      throw new Error(`Email with Message-ID ${messageId} not found in ${from}`);
    }

    await client.messageMove(String(uids[0]), to, { uid: true });
  } finally {
    lock.release();
  }
}

// ============================================================================
// EMAIL META LOOKUPS
// ============================================================================

/**
 * Fetches email metadata (subject, from) for a batch of requests.
 *
 * Groups requests by lookup type:
 * - UID group (no messageId): single lock on INBOX, single batched FETCH
 * - Message-ID group (has messageId): resolve folder paths once, then
 *   lock All Mail for all searches, then lock Trash for any not found
 *
 * Individual failures are skipped (logged), not thrown.
 *
 * @param client - Connected ImapFlow client
 * @param requests - Array of lookup requests, each with an actionId and uid or messageId
 * @returns Map of actionId to EmailMeta for all successful lookups
 */
export async function fetchEmailMetaBatch(
  client: ImapFlow,
  requests: EmailMetaRequest[]
): Promise<Map<string, EmailMeta>> {
  const results = new Map<string, EmailMeta>();

  // Split requests into uid-group and messageId-group
  const uidRequests: EmailMetaRequest[] = [];
  const messageIdRequests: EmailMetaRequest[] = [];

  for (const req of requests) {
    if (req.messageId) {
      messageIdRequests.push(req);
    } else if (req.uid) {
      uidRequests.push(req);
    }
    // Skip requests with neither uid nor messageId
  }

  // UID group: single batched FETCH in INBOX
  if (uidRequests.length > 0) {
    await fetchMetaByUidBatch(client, uidRequests, results);
  }

  // Message-ID group: search All Mail then Trash
  if (messageIdRequests.length > 0) {
    await fetchMetaByMessageIdBatch(client, messageIdRequests, results);
  }

  return results;
}

/**
 * Fetches metadata for UID-based requests in a single batched INBOX FETCH.
 * @param client - Connected ImapFlow client
 * @param requests - Requests with uid set
 * @param results - Map to populate with successful lookups
 */
async function fetchMetaByUidBatch(
  client: ImapFlow,
  requests: EmailMetaRequest[],
  results: Map<string, EmailMeta>
): Promise<void> {
  // Build a UID-to-actionId lookup
  const uidToActionId = new Map<string, string>();
  for (const req of requests) {
    uidToActionId.set(req.uid!, req.actionId);
  }

  const uidSet = requests.map((r) => r.uid!).join(",");
  const lock = await client.getMailboxLock("INBOX");

  try {
    for await (const message of client.fetch(uidSet, {
      envelope: true,
    }, { uid: true })) {
      const msgUid = String(message.uid);
      const actionId = uidToActionId.get(msgUid);
      if (!actionId || !message.envelope) continue;

      results.set(actionId, {
        subject: message.envelope.subject ?? "(no subject)",
        from: formatAddress(message.envelope.from),
      });
    }
  } catch (error) {
    console.warn("[fetchEmailMetaBatch] UID batch fetch failed:", error);
  } finally {
    lock.release();
  }
}

/**
 * Fetches metadata for Message-ID-based requests by searching All Mail, then Trash.
 * @param client - Connected ImapFlow client
 * @param requests - Requests with messageId set
 * @param results - Map to populate with successful lookups
 */
async function fetchMetaByMessageIdBatch(
  client: ImapFlow,
  requests: EmailMetaRequest[],
  results: Map<string, EmailMeta>
): Promise<void> {
  // Resolve folder paths once (no lock needed for client.list())
  const allMailFolder = await resolveSpecialUseFolder(client, "\\All");
  const trashFolder = await resolveSpecialUseFolder(client, "\\Trash");

  // Phase 1: Search All Mail for all message IDs
  const notFound: EmailMetaRequest[] = [];
  const allMailLock = await client.getMailboxLock(allMailFolder);

  try {
    for (const req of requests) {
      try {
        const meta = await searchAndFetchMetaInLock(client, req.messageId!);
        if (meta) {
          results.set(req.actionId, meta);
        } else {
          notFound.push(req);
        }
      } catch (error) {
        console.warn(
          `[fetchEmailMetaBatch] Failed to search messageId ${req.messageId} in All Mail:`,
          error
        );
        notFound.push(req);
      }
    }
  } finally {
    allMailLock.release();
  }

  // Phase 2: Search Trash for any not found in All Mail
  if (notFound.length === 0) return;

  const trashLock = await client.getMailboxLock(trashFolder);

  try {
    for (const req of notFound) {
      try {
        const meta = await searchAndFetchMetaInLock(client, req.messageId!);
        if (meta) {
          results.set(req.actionId, meta);
        }
      } catch (error) {
        console.warn(
          `[fetchEmailMetaBatch] Failed to search messageId ${req.messageId} in Trash:`,
          error
        );
      }
    }
  } finally {
    trashLock.release();
  }
}

/**
 * Searches the currently locked folder by Message-ID header and fetches metadata.
 * Must be called while a mailbox lock is held.
 * @param client - Connected ImapFlow client (with active mailbox lock)
 * @param messageId - The RFC Message-ID header value
 * @returns EmailMeta if found, null otherwise
 */
async function searchAndFetchMetaInLock(
  client: ImapFlow,
  messageId: string
): Promise<EmailMeta | null> {
  const uids = await client.search(
    { header: { "message-id": messageId } },
    { uid: true }
  );

  if (!uids || uids.length === 0) return null;

  const msg = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
  if (!msg || !msg.envelope) return null;

  return {
    subject: msg.envelope.subject ?? "(no subject)",
    from: formatAddress(msg.envelope.from),
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extracts the raw email address from the first entry in an IMAP address array.
 * @param addresses - Array of IMAP address objects
 * @returns Raw email address string (e.g. "alice@example.com")
 */
function extractEmailAddress(addresses: Array<{ name?: string; address?: string }> | undefined): string {
  if (!addresses || addresses.length === 0) {
    return "";
  }
  return addresses[0].address ?? "";
}

/**
 * Extracts raw email addresses from ALL entries in an IMAP address array.
 * @param addresses - Array of IMAP address objects
 * @returns Array of raw email address strings
 */
function extractAllEmailAddresses(addresses: Array<{ name?: string; address?: string }> | undefined): string[] {
  if (!addresses || addresses.length === 0) {
    return [];
  }
  const result: string[] = [];
  for (const addr of addresses) {
    if (addr.address) {
      result.push(addr.address);
    }
  }
  return result;
}

/**
 * Formats an IMAP address array into a readable string.
 * @param addresses - Array of IMAP address objects
 * @returns Formatted address string (e.g. "John Doe <john@example.com>")
 */
function formatAddress(addresses: Array<{ name?: string; address?: string }> | undefined): string {
  if (!addresses || addresses.length === 0) {
    return "(unknown)";
  }

  const addr = addresses[0];
  if (addr.name) {
    return `${addr.name} <${addr.address ?? ""}>`;
  }
  return addr.address ?? "(unknown)";
}

/**
 * Extracts a plain-text snippet using BODYSTRUCTURE to fetch only the text part.
 * Walks the bodyStructure to find text/plain (or text/html), downloads that
 * part via client.download(), decodes it, and truncates to SNIPPET_LENGTH.
 * @param client - Connected ImapFlow client
 * @param uid - UID of the email
 * @param bodyStructure - Parsed bodyStructure from ImapFlow fetch
 * @returns Clean text snippet
 */
async function extractSnippetFromStructure(
  client: ImapFlow,
  uid: number,
  bodyStructure: any
): Promise<string> {
  if (!bodyStructure) return "";

  const textPart = findTextPart(bodyStructure);
  if (!textPart) return "";

  // Download just the text part
  const { meta, content } = await client.download(String(uid), textPart.part, { uid: true });

  // Collect the stream into a buffer
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  // ImapFlow's download() already decodes content-transfer-encoding,
  // so we just need to decode the charset
  const charset = meta.charset ?? "utf-8";
  let text: string;
  try {
    const decoder = new TextDecoder(charset);
    text = decoder.decode(buffer);
  } catch {
    text = buffer.toString("utf-8");
  }

  // Convert HTML to markdown if needed
  if (textPart.type === "text/html") {
    const turndown = new TurndownService();
    text = turndown.turndown(text);
  }

  return text.substring(0, SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
}

/**
 * Walks a bodyStructure tree to find the best text part.
 * Prefers text/plain over text/html.
 * @param node - bodyStructure node from ImapFlow
 * @returns Object with part number and type, or null
 */
function findTextPart(node: any): { part: string; type: string } | null {
  if (!node) return null;

  // Multipart node: has childNodes array
  if (node.childNodes) {
    let plain: { part: string; type: string } | null = null;
    let html: { part: string; type: string } | null = null;
    for (const child of node.childNodes) {
      const result = findTextPart(child);
      if (result) {
        if (result.type === "text/plain" && !plain) plain = result;
        if (result.type === "text/html" && !html) html = result;
      }
    }
    return plain ?? html;
  }

  // Leaf node: check type
  const type = node.type?.toLowerCase() ?? "";
  if (type === "text/plain" || type === "text/html") {
    return { part: node.part ?? "1", type };
  }

  return null;
}

/**
 * Extracts Message-IDs from References and In-Reply-To headers.
 * @param source - Raw email source text
 * @returns Array of Message-ID strings
 */
function extractReferences(source: string): string[] {
  if (!source) return [];

  const ids: string[] = [];
  const headerSection = source.split(/\r?\n\r?\n/)[0] ?? "";

  // Match References and In-Reply-To headers (may span multiple lines)
  for (const headerName of ["References", "In-Reply-To"]) {
    const regex = new RegExp(`^${headerName}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, "mi");
    const match = headerSection.match(regex);
    if (match) {
      // Extract all <...> Message-IDs from the header value
      const msgIdRegex = /<[^>]+>/g;
      let m: RegExpExecArray | null;
      while ((m = msgIdRegex.exec(match[1])) !== null) {
        ids.push(m[0]);
      }
    }
  }

  return [...new Set(ids)];
}

/**
 * Parses a full MIME email source and extracts the body as plain text.
 * Prefers the text/plain part. If only HTML exists, converts to markdown
 * via turndown. Used for full-body reads (readEmail, readThread).
 * @param source - Full raw email source as Buffer or string
 * @returns Plain text body content
 */
async function extractBodyFromMime(source: Buffer | string): Promise<string> {
  if (!source || (Buffer.isBuffer(source) && source.length === 0)) {
    return "";
  }

  const parsed = await simpleParser(source);

  let body = "";

  // Prefer plain text
  if (parsed.text) {
    body = parsed.text.trim();
  } else if (parsed.html) {
    // Fall back to HTML-to-markdown conversion (strip images and empty links)
    const turndown = new TurndownService();
    turndown.addRule("removeImages", { filter: "img", replacement: () => "" });
    turndown.addRule("removeEmptyLinks", {
      filter: (node: HTMLElement) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
    body = turndown.turndown(parsed.html).trim();
  }

  // Normalize CRLF line endings (RFC 5322 uses \r\n)
  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Strip zero-width characters (marketers stuff these into emails)
  body = body.replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "");
  // Collapse multiple spaces
  body = body.replace(/ {2,}/g, " ");

  return body.trim();
}

