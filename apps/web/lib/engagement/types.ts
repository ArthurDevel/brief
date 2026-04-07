/**
 * Type definitions for the engagement email system.
 *
 * Defines the shape of all data structures used across the engagement
 * email pipeline: email types, candidates, event tracking, and content.
 *
 * Responsibilities:
 * - Define the EmailType union of all 10 engagement email keys
 * - Define EmailCandidate for users matched to an email type
 * - Define EmailEventRow for the email_events database table
 * - Define EngagementEmailContent returned by template functions
 * - Define filter input DTOs (UserData, UserSettingsData, etc.)
 */

// ============================================================================
// EMAIL TYPES
// ============================================================================

/** All possible engagement email type keys. */
export type EmailType =
  | "onboarding_incomplete_1h"
  | "onboarding_incomplete_24h"
  | "onboarding_incomplete_72h"
  | "welcome"
  | "no_call_nudge_24h"
  | "no_call_nudge_72h"
  | "first_call_followup"
  | "schedule_nudge"
  | "reengagement_3d"
  | "upgrade_nudge";

// ============================================================================
// CORE INTERFACES
// ============================================================================

/**
 * A user matched to a specific email type, ready to be sent.
 */
export interface EmailCandidate {
  /** The user's auth ID */
  userId: string;
  /** The user's email address */
  email: string;
  /** Which engagement email to send */
  emailType: EmailType;
}

/**
 * A row from the email_events table tracking sent emails.
 */
export interface EmailEventRow {
  /** Primary key */
  id: string;
  /** The user who received the email */
  userId: string;
  /** Which email type was sent */
  emailType: EmailType;
  /** The Resend email ID (null if send failed before recording) */
  resendEmailId: string | null;
  /** When the email was sent */
  sentAt: string;
}

/**
 * Content returned by a template's getContent function.
 * Used by sendEngagementEmail to build the HTML email.
 */
export interface EngagementEmailContent {
  /** Email subject line */
  subject: string;
  /** Heading displayed inside the email body */
  heading: string;
  /** Main body copy */
  body: string;
  /** CTA button text */
  ctaText: string;
  /** CTA button URL */
  ctaUrl: string;
}

// ============================================================================
// FILTER INPUT DTOS
// ============================================================================

/**
 * User data fetched from auth.users via the admin API.
 */
export interface UserData {
  /** The user's auth ID */
  userId: string;
  /** The user's email address */
  email: string;
  /** When the user signed up */
  createdAt: string;
  /** When the user confirmed their email (null if unconfirmed) */
  emailConfirmedAt: string | null;
}

/**
 * User settings data fetched from the user_settings table.
 */
export interface UserSettingsData {
  /** The user's auth ID */
  userId: string;
  /** Phone config (JSONB), null if not set */
  phone: object | null;
  /** PIN hash, null if not set */
  pinHash: string | null;
  /** Call schedule config (JSONB), null if not set */
  callSchedule: object | null;
  /** When the settings were last updated */
  updatedAt: string;
}

/**
 * An active email account from user_email_accounts.
 * Replaces the old imap_host check on user_settings for onboarding completeness.
 */
export interface EmailAccountData {
  /** The user's auth ID */
  userId: string;
}

/**
 * A session row indicating a user had a voice call.
 */
export interface SessionData {
  /** The user's auth ID */
  userId: string;
  /** When the session started */
  startedAt: string;
}

/**
 * Subscription data for a user.
 */
export interface SubscriptionData {
  /** The user's auth ID */
  userId: string;
  /** The user's plan type */
  plan: "free" | "pro";
}

/**
 * A previously sent email, used for dedup and cooldown checks.
 */
export interface SentEmailData {
  /** The user's auth ID */
  userId: string;
  /** Which email type was sent */
  emailType: string;
  /** When the email was sent */
  sentAt: string;
}
