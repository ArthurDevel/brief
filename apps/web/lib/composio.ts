/**
 * Web-side Composio helpers for the WhatsApp connector flows.
 *
 * Responsibilities:
 * - Create the Composio SDK client for authenticated server routes
 * - Start a manual-auth flow for one supported toolkit
 * - Keep the external Composio user ID invariant in one place
 */

import { Composio } from "@composio/core";

// ============================================================================
// CONSTANTS
// ============================================================================

export interface ComposioConnectionRequest {
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
 * Starts a manual-auth flow for a signed-in user.
 * @param userId - The Supabase auth user ID
 * @param toolkit - Toolkit slug, for example "gmail" or "notion"
 * @param callbackUrl - The app callback URL Composio should redirect to
 * @returns The redirect URL the browser should open
 */
export async function createComposioConnectionRequest(
  userId: string,
  toolkit: string,
  callbackUrl: string
): Promise<ComposioConnectionRequest> {
  const composio = createComposioClient();
  const session = await composio.create(getComposioExternalUserId(userId), {
    toolkits: [toolkit],
    manageConnections: false,
  });
  const connectionRequest = await session.authorize(toolkit, {
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
