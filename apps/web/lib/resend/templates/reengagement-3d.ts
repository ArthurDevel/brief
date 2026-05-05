/**
 * Email template: Ready for your next call? (3d+ since last session).
 *
 * Sent to users who made at least one call but have not called
 * in 3+ days.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 3-day reengagement email.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.OpenPokeButVoice.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Ready for your next call?",
    heading: "Ready for your next call?",
    body: "Your inbox has been piling up -- one call on your next commute and you're back on top of it.",
    ctaText: "Go to dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
