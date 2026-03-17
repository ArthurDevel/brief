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
