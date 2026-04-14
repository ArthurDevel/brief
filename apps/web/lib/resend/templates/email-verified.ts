/**
 * Email template: Email verified.
 *
 * Sent immediately after a user confirms their email address.
 * Guides them to continue onboarding from the main app.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Returns the email content for the email verified message.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.brewdock.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Your email is verified",
    heading: "Your email is verified",
    body: "Your account is ready. Next, finish the remaining setup in BrewDock so you can clear your inbox hands-free on your next drive.",
    ctaText: "Open dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
