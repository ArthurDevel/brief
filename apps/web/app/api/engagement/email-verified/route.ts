/**
 * Session-authenticated email verified trigger endpoint.
 *
 * Accepts a browser POST from an allowed origin after Supabase OTP
 * verification succeeds. The endpoint trusts only the Supabase session,
 * re-reads the user via the admin API, confirms the email is verified,
 * and sends the email_verified transactional email exactly once.
 *
 * Responsibilities:
 * - Validate the request origin for cross-subdomain browser calls
 * - Derive identity from the Supabase session cookie only
 * - Re-check auth.users.email_confirmed_at before sending
 * - Trigger the idempotent email_verified send flow
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { triggerEmailVerifiedEmail, type EmailVerifiedTriggerStatus } from "./logic";

// ============================================================================
// TYPES
// ============================================================================

interface EmailVerifiedTriggerResponse {
  /** Whether the endpoint completed successfully */
  success: boolean;
  /** Result of the idempotent send flow */
  status?: EmailVerifiedTriggerStatus;
  /** Safe error string for the caller */
  error?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const LANDER_URL = process.env.LANDER_URL;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ALLOWED_METHODS = "POST, OPTIONS";

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Handles the CORS preflight request for the lander browser call.
 * @param request - Incoming preflight request
 * @returns Empty response with CORS headers for allowed origins
 */
export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const corsHeaders = getCorsHeaders(request);
  if (!corsHeaders) {
    return new NextResponse(null, { status: 403 });
  }

  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Handles the email verified trigger request.
 * @param request - Incoming browser request from the lander
 * @returns JSON response describing whether the email was sent or deduped
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<EmailVerifiedTriggerResponse>> {
  const corsHeaders = getCorsHeaders(request);
  if (!corsHeaders) {
    return NextResponse.json(
      { success: false, error: "Forbidden origin" },
      { status: 403 }
    );
  }

  try {
    if (!LANDER_URL) {
      throw new Error("LANDER_URL is not set");
    }

    if (!APP_URL) {
      throw new Error("NEXT_PUBLIC_APP_URL is not set");
    }

    const cookieStore = await cookies();
    const supabase = createServerSupabaseClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const serviceRoleSupabase = createServiceRoleClient();
    const { data: userResult, error: userError } =
      await serviceRoleSupabase.auth.admin.getUserById(user.id);

    if (userError || !userResult?.user?.email) {
      throw new Error(userError?.message || "Failed to load verified user");
    }

    if (!userResult.user.email_confirmed_at) {
      console.log(`[email-verified] Rejected unconfirmed user ${user.id}`);
      return NextResponse.json(
        { success: false, error: "Email is not verified yet" },
        { status: 409, headers: corsHeaders }
      );
    }

    console.log(`[email-verified] Trigger received for user ${user.id}`);

    const status = await triggerEmailVerifiedEmail({
      supabase: serviceRoleSupabase,
      userId: user.id,
      email: userResult.user.email,
      landerUrl: LANDER_URL,
      appUrl: APP_URL,
    });

    return NextResponse.json(
      { success: true, status },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("[email-verified] Trigger failed:", error);
    return NextResponse.json(
      { success: false, error: "Something went wrong. Please try again." },
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds CORS headers when the request origin is allowed.
 * @param request - Incoming request with the Origin header
 * @returns CORS headers for an allowed origin, or null when blocked
 */
function getCorsHeaders(request: NextRequest): Headers | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  const allowedOrigins = [LANDER_URL, APP_URL].filter(
    (value): value is string => Boolean(value)
  );

  if (!allowedOrigins.includes(origin)) {
    return null;
  }

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");

  return headers;
}
