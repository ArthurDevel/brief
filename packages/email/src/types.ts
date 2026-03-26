/**
 * Type definitions for the email package.
 *
 * Defines configuration and data types for IMAP and SMTP operations.
 *
 * Responsibilities:
 * - ImapConfig/SmtpConfig for connection parameters
 * - EmailSummary for inbox listing
 * - Email for full email content
 */

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

/** A single message within a thread, returned in chronological order. */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}
