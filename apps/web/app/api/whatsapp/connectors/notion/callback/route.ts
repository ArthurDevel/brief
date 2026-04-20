/**
 * Handles Composio redirects for the WhatsApp Notion connection flow.
 *
 * Responsibilities:
 * - Require the user to still have a signed-in WhatsApp/Supabase session
 * - Validate callback query params from Composio
 * - Redirect back to the WhatsApp Notion connector page with a safe notice code
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getWhatsAppConnectorDefinition } from "@/app/whatsapp/connectors/connectorDefinitions";
import { parseConnectorCallback } from "@/app/whatsapp/connectors/connectorLogic";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Persists the Composio callback result and redirects to the WhatsApp page.
 * @param request - Callback request from Composio
 * @returns Redirect back to /whatsapp/connectors/notion
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const definition = getWhatsAppConnectorDefinition("notion");
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToConnectorPage(request, { error: "auth_required" });
  }

  const callback = parseConnectorCallback(request.nextUrl.searchParams);
  if (callback.errorCode && callback.status !== "failed") {
    console.warn("[whatsapp-notion/callback] invalid callback", {
      userId: user.id,
      query: request.nextUrl.search,
    });
    return redirectToConnectorPage(request, { error: callback.errorCode });
  }

  if (callback.status === "success") {
    console.info("[whatsapp-notion/callback] connected", {
      userId: user.id,
      connectedAccountId: callback.connectedAccountId,
    });

    return redirectToConnectorPage(request, { connected: "1" });
  }

  console.warn("[whatsapp-notion/callback] connection failed", {
    userId: user.id,
    query: request.nextUrl.search,
    safeMessage: definition.connectionFailedMessage,
  });

  return redirectToConnectorPage(request, { error: "connection_failed" });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the redirect back to the Notion connector page with safe query params.
 * @param request - Current request used to preserve the origin
 * @param params - Safe query params for the destination page
 * @returns Redirect response to the WhatsApp Notion connector page
 */
function redirectToConnectorPage(
  request: NextRequest,
  params: Record<string, string>
): NextResponse {
  const redirectUrl = new URL("/whatsapp/connectors/notion", request.nextUrl.origin);

  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }

  return NextResponse.redirect(redirectUrl);
}
