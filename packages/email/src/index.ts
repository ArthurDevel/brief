/**
 * Barrel export for @dublin/email package.
 *
 * Re-exports all types, IMAP client functions, and SMTP client functions.
 */

export type { ImapConfig, SmtpConfig, EmailSummary, Email } from "./types";

export {
  createImapConnection,
  closeImapConnection,
  withReconnect,
  listInbox,
  searchEmails,
  readEmail,
  markAsRead,
  archiveEmail,
  deleteEmail,
  moveEmail,
} from "./imap-client";

export { sendEmail, saveDraft, deleteDraft } from "./smtp-client";
