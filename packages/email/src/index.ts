/**
 * Barrel export for @dublin/email package.
 *
 * Re-exports all types, IMAP client functions, and SMTP client functions.
 */

export type { ImapConfig, SmtpConfig, EmailSummary, Email, ThreadMessage, EmailMeta } from "./types";

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
  fetchEmailMetaByMessageId,
  fetchEmailMetaByUid,
} from "./imap-client";

export { sendEmail, saveDraft, deleteDraft, testSmtpConnection } from "./smtp-client";

export { formatEmailSummaries, formatEmail, formatThread } from "./markdown-formatter";
