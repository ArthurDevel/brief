/**
 * Sends fire-and-forget callbacks to the web app after a WhatsApp session ends.
 *
 * Responsibilities:
 * - Notify the web app that a WhatsApp session has been finalized
 * - Authenticate the callback with the shared internal API key
 */

import type { AgentEnv } from "./env.js";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Triggers the web app's WhatsApp end-of-session route without blocking the agent.
 * @param env - Agent environment config
 * @param sessionId - Existing sessions.id value
 * @returns Promise that resolves when the HTTP request finishes
 */
export async function notifyWhatsAppEndOfSession(
  env: AgentEnv,
  sessionId: string
): Promise<void> {
  const url = new URL(`/api/sessions/${sessionId}/whatsapp-end-of-session`, env.webAppUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.internalApiKey}`,
    },
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `WhatsApp end-of-session callback failed (${response.status}): ${responseText}`
    );
  }
}
