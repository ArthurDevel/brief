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
import type { ImapConfig, EmailSummary, Email, ThreadMessage } from "./types";
import type { UndoRecipe } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

const ARCHIVE_FOLDER = "[Gmail]/All Mail";
const TRASH_FOLDER = "[Gmail]/Trash";
const DRAFTS_FOLDER = "[Gmail]/Drafts";
const SNIPPET_LENGTH = 100;

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
    const messages: EmailSummary[] = [];

    // Fetch most recent messages by sequence number (descending)
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      return [];
    }

    const totalMessages = mailbox.exists;
    const startSeq = Math.max(1, totalMessages - limit + 1);
    const range = `${startSeq}:*`;

    for await (const message of client.fetch(range, {
      envelope: true,
      bodyStructure: true,
      source: { maxLength: 2000 },
    })) {
      const envelope = message.envelope;
      if (!envelope) continue;

      const sourceText = message.source?.toString("utf-8") ?? "";
      const snippet = extractSnippet(sourceText);

      messages.push({
        id: String(message.uid),
        from: formatAddress(envelope.from),
        subject: envelope.subject ?? "(no subject)",
        snippet,
        date: envelope.date?.toISOString() ?? "",
      });
    }

    // Return in reverse chronological order
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
    // Use IMAP OR search across subject and from fields
    const searchResult = await client.search({
      or: [{ subject: query }, { from: query }],
    });

    if (!searchResult || searchResult.length === 0) {
      return [];
    }

    const messages: EmailSummary[] = [];
    const uidSet = searchResult.map(String).join(",");

    for await (const message of client.fetch(uidSet, {
      envelope: true,
      uid: true,
      source: { maxLength: 2000 },
    })) {
      const envelope = message.envelope;
      if (!envelope) continue;

      const sourceText = message.source?.toString("utf-8") ?? "";
      const snippet = extractSnippet(sourceText);

      messages.push({
        id: String(message.uid),
        from: formatAddress(envelope.from),
        subject: envelope.subject ?? "(no subject)",
        snippet,
        date: envelope.date?.toISOString() ?? "",
      });
    }

    // Return in reverse chronological order
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
    const sourceText = message.source?.toString("utf-8") ?? "";
    const body = extractBody(sourceText);
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

  // Step 2: Search [Gmail]/All Mail by HEADER for each thread Message-ID
  const allMailLock = await client.getMailboxLock(ARCHIVE_FOLDER);
  try {
    const matchedUids = new Set<number>();

    for (const id of threadIds) {
      // Find messages with this Message-ID
      const byId = await client.search({ header: { "message-id": id } });
      for (const uid of byId) matchedUids.add(uid);

      // Find messages that reference this Message-ID
      const byRef = await client.search({ header: { references: id } });
      for (const uid of byRef) matchedUids.add(uid);
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

      const sourceText = msg.source?.toString("utf-8") ?? "";

      results.push({
        id: String(msg.uid),
        from: formatAddress(msg.envelope.from),
        to: formatAddress(msg.envelope.to),
        subject: msg.envelope.subject ?? "(no subject)",
        body: extractBody(sourceText),
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
  const lock = await client.getMailboxLock(sourceFolder);

  try {
    await client.messageMove(emailId, ARCHIVE_FOLDER, { uid: true });

    return {
      operation: "move_email",
      params: {
        emailId,
        from: ARCHIVE_FOLDER,
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
  const lock = await client.getMailboxLock(sourceFolder);

  try {
    await client.messageMove(emailId, TRASH_FOLDER, { uid: true });

    return {
      operation: "move_email",
      params: {
        emailId,
        from: TRASH_FOLDER,
        to: sourceFolder,
      },
    };
  } finally {
    lock.release();
  }
}

/**
 * Moves an email between IMAP folders. Used by undo to reverse archive/delete.
 * @param client - Connected ImapFlow client
 * @param emailId - The UID of the email to move
 * @param from - Source folder
 * @param to - Destination folder
 */
export async function moveEmail(
  client: ImapFlow,
  emailId: string,
  from: string,
  to: string
): Promise<void> {
  const lock = await client.getMailboxLock(from);

  try {
    await client.messageMove(emailId, to, { uid: true });
  } finally {
    lock.release();
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
 * Extracts a plain-text snippet from a raw email source.
 * @param source - Raw email source text
 * @returns Short snippet of the email body
 */
function extractSnippet(source: string): string {
  const body = extractBody(source);
  if (!body) {
    return "";
  }

  return body.substring(0, SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
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
 * Extracts the plain-text body from a raw email source.
 * Looks for the body after the header/body separator (double newline).
 * @param source - Raw email source text
 * @returns Plain text body content
 */
function extractBody(source: string): string {
  if (!source) {
    return "";
  }

  // Find the header/body separator (double CRLF or double LF)
  const separatorIndex = source.indexOf("\r\n\r\n");
  if (separatorIndex === -1) {
    const lfSeparator = source.indexOf("\n\n");
    if (lfSeparator === -1) {
      return source;
    }
    return source.substring(lfSeparator + 2).trim();
  }

  return source.substring(separatorIndex + 4).trim();
}
