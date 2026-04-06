/**
 * Barrel export for @dublin/email package.
 *
 * Re-exports all types, IMAP client functions, and SMTP client functions.
 */

export type { ImapConfig, SmtpConfig, EmailSummary, Email, ThreadMessage, EmailMeta, EmailMetaRequest, FolderInfo, ReplyContext, EmailAccountRecord, EmailAccountClient } from "./types";

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
  fetchEmailMetaBatch,
  fetchReplyContext,
} from "./imap-client";

export { sendEmail, replyToEmail, saveDraft, deleteDraft, testSmtpConnection } from "./smtp-client";

export { formatEmailSummaries, formatEmail, formatThread, formatFolders } from "./markdown-formatter";

export { createEmailAccountClient } from "./account-client";
