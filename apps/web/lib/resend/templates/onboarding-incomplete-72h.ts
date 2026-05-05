/**
 * Email template: Your setup is almost done (72h after signup).
 *
 * Sent to users who signed up but have not finished onboarding
 * (missing phone, imap_host, or pin_hash) after 72 hours.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 72h incomplete onboarding nudge.
 * @param landerUrl - The lander site base URL (e.g. https://OpenPokeButVoice.com)
 * @param appUrl - The app base URL (not used for this template)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Your setup is almost done",
    heading: "Your setup is almost done",
    body: "Every commute is emails piling up. Setup takes 2 minutes -- tomorrow, arrive with an empty inbox.",
    ctaText: "Complete setup",
    ctaUrl: `${landerUrl}/onboarding`,
  };
}
