/**
 * Handles Composio redirects for the WhatsApp Gmail connection flow.
 *
 * Responsibilities:
 * - Require the user to still have a signed-in WhatsApp/Supabase session
 * - Validate callback query params from Composio
 * - Persist the Gmail connection result in user_composio_connections
 * - Redirect back to the WhatsApp Gmail connector page with a safe notice code
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getComposioExternalUserId } from "@/lib/composio";
import {
  getUserComposioConnection,
  upsertUserComposioConnection,
} from "@/lib/composio-connections";
import { parseGmailConnectCallback } from "@/app/whatsapp/connectors/gmail/logic";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Persists the Composio callback result and redirects to the WhatsApp page.
 * @param request - Callback request from Composio
 * @returns Redirect back to /whatsapp/connectors/gmail
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToConnectorPage(request, { error: "auth_required" });
  }

  const callback = parseGmailConnectCallback(request.nextUrl.searchParams);
  if (callback.errorCode && callback.status !== "failed") {
    console.warn("[whatsapp-gmail/callback] invalid callback", {
      userId: user.id,
      query: request.nextUrl.search,
    });
    return redirectToConnectorPage(request, { error: callback.errorCode });
  }

  try {
    const existingConnection = await getUserComposioConnection(supabase, user.id, "gmail");

    if (callback.status === "success") {
      await upsertUserComposioConnection(supabase, {
        userId: user.id,
        toolkit: "gmail",
        status: "connected",
        connectedAccountId: callback.connectedAccountId,
        connectedAt: new Date().toISOString(),
        externalUserId: getComposioExternalUserId(user.id),
        lastError: null,
      });

      console.info("[whatsapp-gmail/callback] connected", {
        userId: user.id,
        connectedAccountId: callback.connectedAccountId,
      });

      return redirectToConnectorPage(request, { connected: "1" });
    }

    await upsertUserComposioConnection(supabase, {
      userId: user.id,
      toolkit: "gmail",
      status: existingConnection ? "reconnect_required" : "error",
      externalUserId: getComposioExternalUserId(user.id),
      lastError: "Gmail was not connected. Please try again.",
    });

    console.warn("[whatsapp-gmail/callback] connection failed", {
      userId: user.id,
      query: request.nextUrl.search,
    });

    return redirectToConnectorPage(request, { error: "connection_failed" });
  } catch (error) {
    console.error("[whatsapp-gmail/callback] failed to persist callback", {
      userId: user.id,
      query: request.nextUrl.search,
      error: error instanceof Error ? error.message : String(error),
    });

    return redirectToConnectorPage(request, { error: "save_failed" });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the redirect back to the Gmail connector page with safe query params.
 * @param request - Current request used to preserve the origin
 * @param params - Safe query params for the destination page
 * @returns Redirect response to the WhatsApp Gmail connector page
 */
function redirectToConnectorPage(
  request: NextRequest,
  params: Record<string, string>
): NextResponse {
  const redirectUrl = new URL("/whatsapp/connectors/gmail", request.nextUrl.origin);

  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }

  return NextResponse.redirect(redirectUrl);
}
