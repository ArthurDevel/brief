/**
 * Web-side Composio helpers for the WhatsApp Gmail connection flow.
 *
 * Responsibilities:
 * - Create the Composio SDK client for authenticated server routes
 * - Start a Gmail manual-auth flow with a callback URL
 * - Keep the external Composio user ID invariant in one place
 */

import { Composio } from "@composio/core";

// ============================================================================
// CONSTANTS
// ============================================================================

export const GMAIL_COMPOSIO_TOOLKIT = "gmail";

// ============================================================================
// TYPES
// ============================================================================

export interface GmailConnectionRequest {
  redirectUrl: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the external Composio user ID for a Supabase user.
 * @param userId - The Supabase auth user ID
 * @returns The external Composio user ID
 */
export function getComposioExternalUserId(userId: string): string {
  return userId;
}

/**
 * Starts a Gmail manual-auth flow for a signed-in user.
 * @param userId - The Supabase auth user ID
 * @param callbackUrl - The app callback URL Composio should redirect to
 * @returns The redirect URL the browser should open
 */
export async function createGmailConnectionRequest(
  userId: string,
  callbackUrl: string
): Promise<GmailConnectionRequest> {
  const composio = createComposioClient();
  const session = await composio.create(getComposioExternalUserId(userId), {
    toolkits: [GMAIL_COMPOSIO_TOOLKIT],
    manageConnections: false,
  });
  const connectionRequest = await session.authorize(GMAIL_COMPOSIO_TOOLKIT, {
    callbackUrl,
  });
  if (!connectionRequest.redirectUrl) {
    throw new Error("Composio did not return a redirect URL.");
  }

  return {
    redirectUrl: connectionRequest.redirectUrl,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a Composio SDK client for server-side use.
 * @returns Configured Composio client
 */
function createComposioClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is not set");
  }

  return new Composio({
    apiKey,
  });
}
