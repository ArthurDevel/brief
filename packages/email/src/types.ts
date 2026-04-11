/**
 * Type definitions for the email package.
 *
 * Defines configuration and data types for IMAP and SMTP operations.
 *
 * Responsibilities:
 * - ImapConfig/SmtpConfig for connection parameters
 * - EmailSummary for inbox listing
 * - Email for full email content
 * - EmailAccountRecord for provider-agnostic account data
 * - EmailAccountClient for provider-agnostic email operations
 */

import type { UndoRecipe } from "@dublin/tools/src/types";
export type { UndoRecipe };

// ============================================================================
// CONNECTION CONFIG
// ============================================================================

/** IMAP server connection configuration. */
export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Use TLS. Defaults to true. Set to false for local test servers. */
  secure?: boolean;
}

/** SMTP server connection configuration. */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

// ============================================================================
// EMAIL DATA
// ============================================================================

/**
 * A request for email metadata lookup, used in batch operations.
 * At least one of uid or messageId must be set.
 * If both are present, messageId is preferred (stable across folder moves).
 * @property actionId - Action row ID, used as key in the result map
 * @property uid - Email UID for direct fetch in INBOX
 * @property messageId - RFC Message-ID for header search (All Mail / Trash)
 */
export interface EmailMetaRequest {
  actionId: string;
  uid?: string;
  messageId?: string;
}

/** Summary of an email for inbox listings. */
export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

/** Full email content including body and read status. */
export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  isRead: boolean;
}

// ============================================================================
// FOLDER DATA
// ============================================================================

/** Information about an IMAP folder (mailbox). */
export interface FolderInfo {
  /** Full IMAP folder path (e.g. "[Gmail]/Starred") */
  path: string;
  /** Display name -- last segment of the path (e.g. "Starred") */
  name: string;
  /** RFC 6154 special-use flag if present (e.g. "\\Trash"), null otherwise */
  specialUse: string | null;
}

// ============================================================================
// EMAIL META
// ============================================================================

/** Lightweight email metadata used for enriching action arguments. */
export interface EmailMeta {
  /** Email subject line */
  subject: string;
  /** Formatted sender (e.g. "Alice <alice@example.com>") */
  from: string;
}

/** Context needed to build a properly threaded reply to an email. */
export interface ReplyContext {
  /** Message-ID of the original email */
  messageId: string;
  /** Message-IDs from the References header */
  references: string[];
  /** Original sender address (e.g. "alice@example.com") */
  from: string;
  /** Original To recipients */
  to: string[];
  /** Original CC recipients */
  cc: string[];
  /** Original subject line */
  subject: string;
}

/** A single message within a thread, returned in chronological order. */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

// ============================================================================
// EMAIL ACCOUNT RECORD
// ============================================================================

/**
 * A user's email account as stored in user_email_accounts.
 * Used by provider-agnostic email operations across web and voice.
 * @param id - Row ID
 * @param userId - Owner user ID
 * @param provider - Mail provider
 * @param connectionType - How the account connects
 * @param emailAddress - The email address, if known
 * @param unipileAccountId - Unipile account ID (Unipile-backed only)
 * @param status - Current connection status
 * @param lastError - Most recent error message, if any
 * @param customConfig - IMAP/SMTP config (custom accounts only)
 */
export interface EmailAccountRecord {
  id: string;
  userId: string;
  provider: "gmail" | "outlook" | "custom";
  connectionType: "unipile" | "imap_smtp";
  emailAddress: string | null;
  unipileAccountId: string | null;
  status: string;
  lastError: string | null;
  customConfig?: {
    imap: ImapConfig;
    smtp: SmtpConfig;
  };
}

// ============================================================================
// EMAIL ACCOUNT CLIENT
// ============================================================================

/**
 * Provider-agnostic email client interface.
 * Implemented by both custom IMAP/SMTP and Unipile-backed clients.
 */
export interface EmailAccountClient {
  listInbox(limit: number): Promise<EmailSummary[]>;
  searchEmails(query: string): Promise<EmailSummary[]>;
  readEmail(emailId: string): Promise<Email>;
  readThread(emailId: string): Promise<ThreadMessage[]>;
  markAsRead(emailId: string): Promise<void>;
  archiveEmail(emailId: string, sourceFolder?: string): Promise<UndoRecipe | null>;
  deleteEmail(emailId: string, sourceFolder?: string): Promise<UndoRecipe | null>;
  moveToFolder(emailId: string, folder: string, sourceFolder?: string): Promise<UndoRecipe | null>;
  batchMoveToFolder(emailIds: string[], folder: string, sourceFolder?: string): Promise<{ emailId: string; undoRecipe: UndoRecipe | null }[]>;
  moveEmail(identifier: string, destFolder: string, sourceFolder?: string, rfcMessageId?: string): Promise<void>;
  listFolders(): Promise<FolderInfo[]>;
  resolveSpecialUseFolder(flag: string): Promise<string | null>;
  saveDraft(input: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string }): Promise<UndoRecipe | null>;
  deleteDraft(uid: number): Promise<void>;
  sendEmail(input: { to: string; subject: string; body: string }): Promise<void>;
  replyEmail(input: { context: ReplyContext; body: string; replyAll: boolean; senderAddress: string }): Promise<void>;
  fetchReplyContext(emailId: string): Promise<ReplyContext>;
  fetchEmailMetaBatch(ids: EmailMetaRequest[]): Promise<Map<string, EmailMeta>>;
}
