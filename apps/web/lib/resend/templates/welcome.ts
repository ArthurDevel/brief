/**
 * Email template: Welcome to OpenPokeButVoice.
 *
 * Sent to users 1h+ after completing onboarding.
 * Guides them toward making their first call.
 *
 * Responsibilities:
 * - Return subject, heading, body, CTA text, and CTA URL
 */

import type { EngagementEmailContent } from "../../engagement/types";

/**
 * Returns the email content for the welcome email.
 * @param landerUrl - The lander site base URL (not used for this template)
 * @param appUrl - The app base URL (e.g. https://app.OpenPokeButVoice.com)
 * @returns Email content with subject, heading, body, CTA text, and CTA URL
 */
export function getContent(
  landerUrl: string,
  appUrl: string
): EngagementEmailContent {
  return {
    subject: "Welcome to OpenPokeButVoice",
    heading: "Welcome to OpenPokeButVoice",
    body: "You're ready. Next time you're in the car, call your inbox -- emails read aloud, replies sent by voice, arrive with a clean slate.",
    ctaText: "Go to dashboard",
    ctaUrl: `${appUrl}/dashboard`,
  };
}
