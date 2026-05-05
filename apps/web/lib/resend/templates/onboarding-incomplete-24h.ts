/**
 * Email template: Pick up where you left off (24h after signup).
 *
 * Sent to users who signed up but have not finished onboarding
 * (missing phone, imap_host, or pin_hash) after 24 hours.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 24h incomplete onboarding nudge.
 * @param landerUrl - The lander site base URL (e.g. https://OpenPokeButVoice.com)
 * @param appUrl - The app base URL (not used for this template)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Pick up where you left off",
    heading: "Pick up where you left off",
    body: "47 emails waiting when you arrive at work, or 3. You're a few steps from clearing your inbox on the drive in.",
    ctaText: "Complete setup",
    ctaUrl: `${landerUrl}/onboarding`,
  };
}
