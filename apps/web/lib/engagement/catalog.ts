/**
 * Shared catalog for engagement email types, labels, and templates.
 *
 * Centralizes the transactional email registry so admin pages, cron routes,
 * and event-triggered sends all resolve the same labels and template content.
 *
 * Responsibilities:
 * - Define the ordered list of previewable email types
 * - Resolve display labels and path labels for admin UI
 * - Resolve template content for each engagement email type
 */

import type { EmailType, EngagementEmailContent } from "./types";
import { getContent as onboardingIncomplete1h } from "../resend/templates/onboarding-incomplete-1h";
import { getContent as onboardingIncomplete24h } from "../resend/templates/onboarding-incomplete-24h";
import { getContent as onboardingIncomplete72h } from "../resend/templates/onboarding-incomplete-72h";
import { getContent as welcome } from "../resend/templates/welcome";
import { getContent as noCallNudge24h } from "../resend/templates/no-call-nudge-24h";
import { getContent as noCallNudge72h } from "../resend/templates/no-call-nudge-72h";
import { getContent as firstCallFollowup } from "../resend/templates/first-call-followup";
import { getContent as scheduleNudge } from "../resend/templates/schedule-nudge";
import { getContent as reengagement3d } from "../resend/templates/reengagement-3d";
import { getContent as upgradeNudge } from "../resend/templates/upgrade-nudge";
import { getContent as emailVerified } from "../resend/templates/email-verified";

// ============================================================================
// TYPES
// ============================================================================

export interface EmailTypeOption {
  /** The database email_type key */
  value: EmailType;
  /** Human-readable label for admin surfaces */
  label: string;
}

type TemplateResolver = (
  landerUrl: string,
  appUrl: string
) => EngagementEmailContent;

// ============================================================================
// CONSTANTS
// ============================================================================

export const EMAIL_TYPE_OPTIONS: EmailTypeOption[] = [
  { value: "email_verified", label: "Email verified" },
  { value: "onboarding_incomplete_1h", label: "Onboarding incomplete (1h)" },
  { value: "onboarding_incomplete_24h", label: "Onboarding incomplete (24h)" },
  { value: "onboarding_incomplete_72h", label: "Onboarding incomplete (72h)" },
  { value: "welcome", label: "Welcome" },
  { value: "no_call_nudge_24h", label: "No call nudge (24h)" },
  { value: "no_call_nudge_72h", label: "No call nudge (72h)" },
  { value: "first_call_followup", label: "First call followup" },
  { value: "schedule_nudge", label: "Schedule nudge" },
  { value: "reengagement_3d", label: "Re-engagement (3d)" },
  { value: "upgrade_nudge", label: "Upgrade nudge" },
];

const TEMPLATE_MAP: Record<EmailType, TemplateResolver> = {
  email_verified: emailVerified,
  onboarding_incomplete_1h: onboardingIncomplete1h,
  onboarding_incomplete_24h: onboardingIncomplete24h,
  onboarding_incomplete_72h: onboardingIncomplete72h,
  welcome: welcome,
  no_call_nudge_24h: noCallNudge24h,
  no_call_nudge_72h: noCallNudge72h,
  first_call_followup: firstCallFollowup,
  schedule_nudge: scheduleNudge,
  reengagement_3d: reengagement3d,
  upgrade_nudge: upgradeNudge,
};

// ============================================================================
// MAIN ENTRYPOINTS
// ============================================================================

/**
 * Returns the admin label for an email type key.
 * @param emailType - The raw email_type value from the database
 * @returns Human-readable label for UI display
 */
export function getEmailTypeLabel(emailType: string): string {
  const match = EMAIL_TYPE_OPTIONS.find((option) => option.value === emailType);
  return match ? match.label : emailType;
}

/**
 * Returns the admin path label for an email type key.
 * @param emailType - The raw email_type value from the database
 * @returns Path label shown in the transactional table
 */
export function getEmailPathLabel(emailType: string): string {
  if (emailType === "email_verified") return "EV";
  if (emailType.startsWith("onboarding_incomplete")) return "P1";

  if (
    emailType === "welcome" ||
    emailType.startsWith("no_call_nudge") ||
    emailType === "first_call_followup" ||
    emailType === "schedule_nudge"
  ) {
    return "P2";
  }

  if (emailType === "reengagement_3d") return "P3";
  if (emailType === "upgrade_nudge") return "P4";

  return "?";
}

/**
 * Returns the admin preview dropdown label for an email type.
 * @param emailType - The engagement email key
 * @returns Label prefixed with the admin path group
 */
export function getEmailPreviewLabel(emailType: EmailType): string {
  return `${getEmailPathLabel(emailType)} - ${getEmailTypeLabel(emailType)}`;
}

/**
 * Resolves template content for a specific engagement email type.
 * @param emailType - The engagement email key
 * @param landerUrl - The lander site base URL
 * @param appUrl - The app base URL
 * @returns Template content for the selected email type
 */
export function getEngagementEmailContent(
  emailType: EmailType,
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  const getContent = TEMPLATE_MAP[emailType];
  return getContent(landerUrl, appUrl);
}
