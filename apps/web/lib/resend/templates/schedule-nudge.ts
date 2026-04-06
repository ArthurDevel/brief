/**
 * Email template: Never miss your morning inbox clear (3d+, no schedule).
 *
 * Sent to users 3d+ after completing onboarding who have not
 * set up a call schedule.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the schedule nudge email.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.brewdock.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Never miss your morning inbox clear",
    heading: "Never miss your morning inbox clear",
    body: "Schedule a daily call so BrewDock rings you automatically -- clear your inbox without even thinking about it.",
    ctaText: "Set up schedule",
    ctaUrl: `${appUrl}/dashboard/settings`,
  };
}
