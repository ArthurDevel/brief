/**
 * Resend email client for system-generated transactional emails.
 *
 * Provides a singleton Resend client and functions to send
 * transactional emails (session summaries, engagement emails).
 *
 * Responsibilities:
 * - Initialize Resend client from RESEND_API_KEY env var
 * - Send session summary emails via sendSessionSummary()
 * - Send engagement emails via sendEngagementEmail()
 * - Provide shared HTML shell for consistent email styling
 */

import { Resend } from "resend";
import type { ActionRow } from "@dublin/tools";
import type { EngagementEmailContent } from "../engagement/types";
import { buildSessionSummaryHtml } from "./templates/sessionSummary";

// ============================================================================
// CONSTANTS
// ============================================================================

const FONT_FAMILY =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

/**
 * Builds the full "From" field for Resend emails.
 * If RESEND_FROM_NAME is set, returns "Name <address>", otherwise just the address.
 * @returns Formatted from string (e.g. "BrewDock <noreply@brewdock.com>")
 */
function getFromField(): string {
  const address = process.env.RESEND_FROM_ADDRESS;
  if (!address) {
    throw new Error("RESEND_FROM_ADDRESS is not set");
  }

  const name = process.env.RESEND_FROM_NAME;
  if (!name) return address;

  return `${name} <${address}>`;
}

// ============================================================================
// SINGLETON CLIENT
// ============================================================================

let resendClient: Resend | null = null;

/**
 * Returns the singleton Resend client. Throws if RESEND_API_KEY is not set.
 * @returns The Resend client instance
 */
function getResendClient(): Resend {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }

  resendClient = new Resend(apiKey);
  return resendClient;
}

// ============================================================================
// MAIN ENTRYPOINTS
// ============================================================================

/**
 * Sends a session summary email listing all actions taken during a session.
 * @param to - Recipient email address
 * @param sessionId - The session ID (used in subject line)
 * @param actions - List of actions taken during the session
 * @param reviewUrl - Short-lived review URL for the recap email
 * @returns Promise that resolves when the email is sent
 */
export async function sendSessionSummary(
  to: string,
  sessionId: string,
  actions: ActionRow[],
  reviewUrl: string
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }

  const client = getResendClient();
  const html = buildSessionSummaryHtml(actions, sessionId, appUrl, reviewUrl);

  const { data, error } = await client.emails.send({
    from: getFromField(),
    to,
    subject: `Session Summary - ${actions.length} action${actions.length === 1 ? "" : "s"} taken`,
    html,
  });

  if (error) {
    throw new Error(`Failed to send session summary email: ${error.message}`);
  }

  console.log(`[resend] Email sent to ${to}, id: ${data?.id}`);
}

/**
 * Sends an engagement email (onboarding, nudge, reengagement, etc.) via Resend.
 * Uses the same HTML structure and styles as session summary emails.
 * Includes List-Unsubscribe header for Resend's automatic unsubscribe handling.
 *
 * @param to - Recipient email address
 * @param content - The engagement email content (subject, heading, body, CTA)
 * @returns The Resend email ID on success, or null on error
 */
export async function sendEngagementEmail(
  to: string,
  content: EngagementEmailContent
): Promise<string | null> {
  const client = getResendClient();
  const html = buildEngagementEmailHtml(content);

  const { data, error } = await client.emails.send({
    from: getFromField(),
    to,
    subject: content.subject,
    html,
    headers: {
      "List-Unsubscribe": `<mailto:unsubscribe@brewdock.com?subject=unsubscribe>`,
    },
  });

  if (error) {
    console.error(`[resend] Failed to send engagement email to ${to}: ${error.message}`);
    return null;
  }

  console.log(`[resend] Engagement email sent to ${to}, id: ${data?.id}`);
  return data?.id ?? null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the full HTML body for an engagement email.
 * Uses the same outer shell, logo, heading, CTA, and footer styles
 * as the session summary template.
 *
 * @param content - The engagement email content
 * @returns HTML string ready to send
 */
export function buildEngagementEmailHtml(content: EngagementEmailContent): string {
  const buttonStyle = `display:inline-block; padding:12px 28px; background-color:#000000; color:#ffffff; text-decoration:none; font-family:${FONT_FAMILY}; font-size:15px; font-weight:600;`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${content.subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

  <!-- Preheader -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    ${content.body}
  </div>

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Email container -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e4e4e7;">

          <!-- Logo -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:28px; height:28px; background-color:#000000; text-align:center; vertical-align:middle; font-family:Georgia,Times,'Times New Roman',serif; font-size:16px; color:#ffffff; line-height:28px;">
                    B
                  </td>
                  <td style="padding-left:8px; font-family:${FONT_FAMILY}; font-size:16px; font-weight:700; color:#000000; letter-spacing:-0.02em;">
                    BrewDock
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <h1 style="margin:0 0 16px 0; font-family:${FONT_FAMILY}; font-size:24px; font-weight:800; color:#000000; letter-spacing:-0.03em; line-height:1.2;">
                ${content.heading}
              </h1>
              <p style="margin:0 0 24px 0; font-family:${FONT_FAMILY}; font-size:15px; font-weight:500; color:#52525b; line-height:1.5;">
                ${content.body}
              </p>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding:0 40px 32px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#000000;">
                    <a href="${content.ctaUrl}" target="_blank" style="${buttonStyle}">
                      ${content.ctaText} &#8594;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px; background-color:#fafafa; border-top:1px solid #e4e4e7;">
              <p style="margin:0 0 4px 0; font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; color:#71717a;">
                BrewDock
              </p>
              <p style="margin:0 0 12px 0; font-family:${FONT_FAMILY}; font-size:12px; font-weight:500; color:#a1a1aa;">
                Do your email while you drive.
              </p>
              <p style="margin:0; font-family:${FONT_FAMILY}; font-size:11px; font-weight:400; color:#a1a1aa; line-height:1.5;">
                BrewDock Inc., 123 Main Street, Suite 100, San Francisco, CA 94105
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}
