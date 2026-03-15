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
// USER SETTINGS
// ============================================================================

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
  toolApprovalConfig: ToolApprovalConfig;
  phoneNumber: string | null;
  hasPin: boolean;
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
  toolApprovalConfig: ToolApprovalConfig;
  pin?: string;
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

/** A key-value memory entry stored by the assistant. */
export interface MemoryEntry {
  key: string;
  value: string;
}

/** A user-submitted feature request. */
export interface FeatureRequest {
  id: string;
  description: string;
  source: "voice" | "dashboard";
  sessionId: string | null;
  createdAt: string;
}
