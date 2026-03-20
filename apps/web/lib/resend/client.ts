/**
 * Resend email client for system-generated transactional emails.
 *
 * Provides a singleton Resend client and functions to send
 * transactional emails (e.g. session summaries).
 *
 * Responsibilities:
 * - Initialize Resend client from RESEND_API_KEY env var
 * - Send session summary emails via sendSessionSummary()
 */

import { Resend } from "resend";
import type { ActionRow } from "@dublin/tools";
import { buildSessionSummaryHtml } from "./templates/sessionSummary";

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
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Sends a session summary email listing all actions taken during a session.
 * @param to - Recipient email address
 * @param sessionId - The session ID (used in subject line)
 * @param actions - List of actions taken during the session
 * @returns Promise that resolves when the email is sent
 */
export async function sendSessionSummary(
  to: string,
  sessionId: string,
  actions: ActionRow[]
): Promise<void> {
  const fromAddress = process.env.RESEND_FROM_ADDRESS;
  if (!fromAddress) {
    throw new Error("RESEND_FROM_ADDRESS is not set");
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }

  const client = getResendClient();
  const html = buildSessionSummaryHtml(actions, sessionId, appUrl);

  const { data, error } = await client.emails.send({
    from: fromAddress,
    to,
    subject: `Session Summary - ${actions.length} action${actions.length === 1 ? "" : "s"} taken`,
    html,
  });

  if (error) {
    throw new Error(`Failed to send session summary email: ${error.message}`);
  }

  console.log(`[resend] Email sent to ${to}, id: ${data?.id}`)
}
