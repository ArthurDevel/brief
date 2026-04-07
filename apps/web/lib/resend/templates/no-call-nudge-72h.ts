/**
 * Email template: Arrive at work with an empty inbox (72h, no calls yet).
 *
 * Sent to users 72h+ after completing onboarding who have
 * not made any calls yet.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the 72h no-call nudge.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.brewdock.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Arrive at work with an empty inbox",
    heading: "Arrive at work with an empty inbox",
    body: "40 minutes driving, 30 emails handled. Quick replies sent, junk archived -- your morning starts with real work.",
    ctaText: "Go to dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
