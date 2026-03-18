/**
 * Barrel export for @dublin/email package.
 *
 * Re-exports all types, IMAP client functions, and SMTP client functions.
 */

export type { ImapConfig, SmtpConfig, EmailSummary, Email, ThreadMessage } from "./types";

export {
  createImapConnection,
  closeImapConnection,
  withReconnect,
  listInbox,
  searchEmails,
  readEmail,
  readThread,
  markAsRead,
  archiveEmail,
  deleteEmail,
  moveEmail,
  resolveSpecialUseFolder,
} from "./imap-client";

export { sendEmail, saveDraft, deleteDraft } from "./smtp-client";

export { formatEmailSummaries, formatEmail, formatThread } from "./markdown-formatter";
