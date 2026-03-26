/**
 * Barrel export for @dublin/email package.
 *
 * Re-exports all types, IMAP client functions, and SMTP client functions.
 */

export type { ImapConfig, SmtpConfig, EmailSummary, Email, ThreadMessage, EmailMeta, FolderInfo } from "./types";

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
  listFolders,
  moveEmailToFolder,
  resolveSpecialUseFolder,
  fetchEmailMetaByMessageId,
  fetchEmailMetaByUid,
} from "./imap-client";

export { sendEmail, saveDraft, deleteDraft, testSmtpConnection } from "./smtp-client";

export { formatEmailSummaries, formatEmail, formatThread, formatFolders } from "./markdown-formatter";
