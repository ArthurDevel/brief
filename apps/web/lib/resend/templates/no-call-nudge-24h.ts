/**
 * Email template: Make your next commute count (24h, no calls yet).
 *
 * Sent to users 24h+ after completing onboarding who have
 * not made any calls yet.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 24h no-call nudge.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.brewdock.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Make your next commute count",
    heading: "Make your next commute count",
    body: "Your inbox is piling up. One call on your commute and you arrive at work with it cleared -- just dial in when you get in the car.",
    ctaText: "Go to dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
