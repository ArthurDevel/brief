/**
 * Email template: Complete your setup (1h after signup).
 *
 * Sent to users who signed up but have not finished onboarding
 * (missing phone, imap_host, or pin_hash) after 1 hour.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 1h incomplete onboarding nudge.
 * @param landerUrl - The lander site base URL (e.g. https://OpenPokeButVoice.com)
 * @param appUrl - The app base URL (not used for this template)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Complete your setup",
    heading: "Complete your setup",
    body: "Your next commute could clear your inbox -- finish setup in 2 minutes and handle emails hands-free on your drive.",
    ctaText: "Complete setup",
    ctaUrl: `${landerUrl}/onboarding`,
  };
}
