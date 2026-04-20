/**
 * Starts the WhatsApp-scoped Gmail connection flow.
 *
 * Responsibilities:
 * - Require an authenticated WhatsApp/Supabase session
 * - Rate limit repeated connect-link creation
 * - Create a Composio Gmail auth URL for the signed-in user
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { checkRateLimit } from "@/lib/request-rate-limit";
import { createGmailConnectionRequest } from "@/lib/composio";

// ============================================================================
// CONSTANTS
// ============================================================================

const START_LIMIT_MAX = 5;
const START_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Creates a Composio Gmail connect URL for the current signed-in user.
 * @param request - Incoming request used for rate limiting
 * @returns JSON containing the redirect URL
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<{ redirectUrl: string } | { code: string; error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      {
        code: "UNAUTHORIZED",
        error: "Sign in with your WhatsApp number before you connect Gmail.",
      },
      { status: 401 }
    );
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rateLimit = checkRateLimit(
    "whatsapp-gmail-connect-start",
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
      "/api/whatsapp/connectors/gmail/callback",
      request.nextUrl.origin
    ).toString();
    const connectionRequest = await createGmailConnectionRequest(user.id, callbackUrl);

    console.info("[whatsapp-gmail/start] created connect link", {
      userId: user.id,
      callbackUrl,
    });

    return NextResponse.json({
      redirectUrl: connectionRequest.redirectUrl,
    });
  } catch (error) {
    console.error("[whatsapp-gmail/start] failed to create connect link", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        code: "CONNECTOR_START_FAILED",
        error: "We could not start the Gmail connection. Please try again.",
      },
      { status: 502 }
    );
  }
}
