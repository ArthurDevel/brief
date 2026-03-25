/**
 * Web app domain types for the voice email assistant dashboard.
 *
 * Defines the DTOs used across the dashboard UI and API routes:
 * - UserSettings: user configuration (IMAP/SMTP, voice, approvals)
 * - SessionSummary: condensed call session for list views
 * - SessionDetail: full session with transcript and actions
 * - UsageInfo: billing period usage data
 * - MemoryEntry: key-value pair stored by the assistant
 * - FeatureRequest: user-submitted feature request
 */

import type { ToolApprovalConfig, ActionRow } from "@dublin/tools/src/types";

// ============================================================================
// PHONE
// ============================================================================

/**
 * A user's personal phone number with country info.
 * @param number - Phone number in E.164 format (e.g. "+15551234567")
 * @param countryCode - ISO 3166-1 alpha-2 country code (e.g. "US")
 */
export interface UserPhone {
  number: string;
  countryCode: string;
}

/**
 * A company-owned phone number used for outbound calls and caller ID.
 * @param id - Unique identifier
 * @param phoneNumber - Phone number in E.164 format
 * @param label - Human-readable label (e.g. "United States")
 * @param countryCode - ISO 3166-1 alpha-2 country code
 * @param environment - "dev" or "prod"
 */
export interface CompanyPhone {
  id: string;
  phoneNumber: string;
  label: string;
  countryCode: string;
  environment: string;
}

// ============================================================================
// USER SETTINGS
// ============================================================================

/**
 * Weekly call schedule configuration stored as JSONB in user_settings.
 * @param timezone - IANA timezone string (e.g. "America/New_York")
 * @param last_call_at - ISO 8601 timestamp of the last scheduled call (read-only, set by scheduler)
 * @param monday - "HH:MM" local time or null (no call)
 * @param tuesday - "HH:MM" local time or null (no call)
 * @param wednesday - "HH:MM" local time or null (no call)
 * @param thursday - "HH:MM" local time or null (no call)
 * @param friday - "HH:MM" local time or null (no call)
 * @param saturday - "HH:MM" local time or null (no call)
 * @param sunday - "HH:MM" local time or null (no call)
 */
export interface CallSchedule {
  timezone: string;
  last_call_at: string | null;
  monday: string | null;
  tuesday: string | null;
  wednesday: string | null;
  thursday: string | null;
  friday: string | null;
  saturday: string | null;
  sunday: string | null;
}

/** User configuration as returned by the settings API. Passwords are never exposed. */
export interface UserSettings {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  hasImapPassword: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  hasSmtpPassword: boolean;
  voicePreference: string;
  voiceSpeed: number;
  toolApprovalConfig: ToolApprovalConfig;
  phone: UserPhone | null;
  hasPin: boolean;
  callSchedule: CallSchedule | null;
}

/** Payload for updating user settings via PUT. Passwords are optional (only sent when changed). */
export interface UserSettingsUpdate {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword?: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword?: string;
  voicePreference: string;
  voiceSpeed: number;
  toolApprovalConfig: ToolApprovalConfig;
  pin?: string;
  callSchedule?: CallSchedule | null;
}

// ============================================================================
// SESSIONS
// ============================================================================

/** Transcript entry from a voice call. */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

/** Condensed call session for list views. */
export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  actionCount: number;
}

/** Full session detail with transcript and actions. */
export interface SessionDetail {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  transcript: TranscriptEntry[];
  actions: ActionRow[];
}

// ============================================================================
// BILLING
// ============================================================================

/** Response from the upgrade API endpoint. 200 includes plan, non-200 includes error. */
export interface UpgradeResponse {
  plan: "free" | "pro";
  error?: string;
}

/** Current billing period usage information. */
export interface UsageInfo {
  plan: "free" | "pro";
  hoursUsed: number;
  hoursLimit: number;
  hoursRemaining: number;
  periodStart: string;
  periodEnd: string;
}

// ============================================================================
// MEMORY + FEATURE REQUESTS
// ============================================================================

/** A memory entry stored by the assistant. */
export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: string;
}

/** A user-submitted feature request. */
export interface FeatureRequest {
  id: string;
  description: string;
  source: "voice" | "dashboard";
  sessionId: string | null;
  createdAt: string;
}
