/**
 * Email template: How was your first call? (24h after first session).
 *
 * Sent to users 24h+ after their first session. Asks for honest
 * feedback and invites a reply.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the first-call followup email.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.brewdock.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "How was your first call?",
    heading: "How was your first call?",
    body: "I'd love your honest feedback on the experience. What worked, what didn't -- I read every email personally. Just hit reply and let me know.",
    ctaText: "Go to dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
