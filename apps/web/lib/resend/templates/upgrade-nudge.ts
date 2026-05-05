/**
 * Email template: Unlock more with Pro (14d+, free plan, 3+ sessions).
 *
 * Sent to active free-plan users who have been using the product
 * for 14+ days with 3+ sessions.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the upgrade nudge email.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.OpenPokeButVoice.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Unlock more with Pro",
    heading: "Unlock more with Pro",
    body: "You've been clearing your inbox on the go. With Pro you get 6 hours/month, scheduled daily calls, and priority replies.",
    ctaText: "View plans",
    ctaUrl: `${appUrl}/dashboard/billing`,
  };
}
