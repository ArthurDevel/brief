/**
 * Starts the WhatsApp-scoped Notion connection flow.
 *
 * Responsibilities:
 * - Require an authenticated WhatsApp/Supabase session
 * - Rate limit repeated connect-link creation
 * - Create a Composio Notion auth URL for the signed-in user
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { checkRateLimit } from "@/lib/request-rate-limit";
import { createComposioConnectionRequest } from "@/lib/composio";
import { getWhatsAppConnectorDefinition } from "@/app/whatsapp/connectors/connectorDefinitions";

// ============================================================================
// CONSTANTS
// ============================================================================

const START_LIMIT_MAX = 5;
const START_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Creates a Composio Notion connect URL for the current signed-in user.
 * @param request - Incoming request used for rate limiting
 * @returns JSON containing the redirect URL
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<{ redirectUrl: string } | { code: string; error: string }>> {
  const definition = getWhatsAppConnectorDefinition("notion");
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      {
        code: "UNAUTHORIZED",
        error: definition.authRequiredMessage,
      },
      { status: 401 }
    );
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rateLimit = checkRateLimit(
    "whatsapp-notion-connect-start",
    `${user.id}:${ipAddress}`,
    START_LIMIT_MAX,
    START_LIMIT_WINDOW_MS
  );

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        code: "RATE_LIMITED",
        error: `Too many attempts. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
      },
      { status: 429 }
    );
  }

  try {
    const callbackUrl = new URL(
      "/api/whatsapp/connectors/notion/callback",
      request.nextUrl.origin
    ).toString();
    const connectionRequest = await createComposioConnectionRequest(
      user.id,
      definition.toolkit,
      callbackUrl
    );

    console.info("[whatsapp-notion/start] created connect link", {
      userId: user.id,
      callbackUrl,
    });

    return NextResponse.json({
      redirectUrl: connectionRequest.redirectUrl,
    });
  } catch (error) {
    console.error("[whatsapp-notion/start] failed to create connect link", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        code: "CONNECTOR_START_FAILED",
        error: definition.startFailedMessage,
      },
      { status: 502 }
    );
  }
}
