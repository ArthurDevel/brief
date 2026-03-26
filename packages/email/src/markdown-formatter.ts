/**
 * Markdown formatting functions for email tool results.
 *
 * Converts structured email data into compact markdown strings for LLM consumption.
 *
 * - Formats inbox/search listings as bullet lists with snippets
 * - Formats full emails with inline bold metadata and body
 * - Formats thread conversations with --- separators between messages
 */

import type { EmailSummary, Email, ThreadMessage, FolderInfo } from "./types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Formats a list of email summaries as a markdown bullet list with snippets.
 * Used by list_inbox and search_emails.
 *
 * @param emails - List of email summaries to format.
 * @param title - Header title (e.g. "Inbox" or "Search Results").
 * @returns Markdown string with header and bullet list.
 */
export function formatEmailSummaries(emails: EmailSummary[], title: string): string {
  const lines: string[] = [];

  lines.push(`## ${title} (${emails.length} emails)`);
  lines.push("");

  for (const email of emails) {
    lines.push(`- **[id:${email.id}]** From: ${email.from} | ${email.date}`);
    lines.push(`  **${email.subject}**`);
    lines.push(`  > ${email.snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Formats a single full email as markdown with inline metadata and body.
 *
 * @param email - Full email content to format.
 * @returns Markdown string with subject as h1, metadata lines, hr, then body.
 */
export function formatEmail(email: Email): string {
  const status = email.isRead ? "Read" : "Unread";

  const lines: string[] = [];
  lines.push(`# ${email.subject}`);
  lines.push("");
  lines.push(`**ID:** ${email.id}`);
  lines.push(`**From:** ${email.from}`);
  lines.push(`**To:** ${email.to}`);
  lines.push(`**Date:** ${email.date}`);
  lines.push(`**Status:** ${status}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(email.body);

  return lines.join("\n");
}

/**
 * Formats a thread as markdown with --- separators between messages.
 *
 * @param messages - List of thread messages in chronological order.
 * @returns Markdown string with thread header, then messages separated by ---.
 */
export function formatThread(messages: ThreadMessage[]): string {
  if (messages.length === 0) {
    return "# Thread (0 messages)";
  }

  const subject = messages[0].subject;
  const lines: string[] = [];

  lines.push(`# Thread: ${subject} (${messages.length} messages)`);
  lines.push("");

  for (const msg of messages) {
    lines.push("---");
    lines.push("");
    lines.push(`**From:** ${msg.from}`);
    lines.push(`**To:** ${msg.to}`);
    lines.push(`**Date:** ${msg.date} | **ID:** ${msg.id}`);
    lines.push("");
    lines.push(msg.body);
    lines.push("");
  }

  lines.push("---");

  return lines.join("\n");
}

/**
 * Formats a list of folders as a markdown bullet list.
 * Special-use folders are annotated with their RFC 6154 flag.
 *
 * @param folders - List of folder info objects to format.
 * @returns Markdown string with header and bullet list.
 */
export function formatFolders(folders: FolderInfo[]): string {
  const lines: string[] = [];

  lines.push(`## Folders (${folders.length})`);
  lines.push("");

  for (const folder of folders) {
    const annotation = folder.specialUse ? ` (${folder.specialUse})` : "";
    lines.push(`- ${folder.path}${annotation}`);
  }

  return lines.join("\n");
}
