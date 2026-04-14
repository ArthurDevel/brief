/**
 * Authenticated proxy for triggering an initial onboarding call.
 *
 * Verifies the user's identity via Supabase session or onboarding token,
 * then forwards the request to the voice pipeline's /trigger-call endpoint.
 *
 * Responsibilities:
 * - Verify auth: Supabase session first, brewdock_onboarding HMAC token as fallback
 * - Forward POST to voice pipeline with INTERNAL_API_KEY
 * - Add CORS headers for cross-subdomain requests from the lander
 */

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import {
  getDashboardErrorMessage,
  type DashboardErrorCode,
} from "@/lib/errors/dashboardErrors";
import { mapDashboardErrorDetails } from "@/lib/errors/mapDashboardError";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_PIPELINE_URL = process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const LANDER_URL = process.env.LANDER_URL;
const ONBOARDING_TOKEN_SECRET = process.env.ONBOARDING_TOKEN_SECRET;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build CORS headers for cross-subdomain requests from the lander.
 * @returns Headers object with CORS configuration
 */
function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": LANDER_URL || "",
    "Access-Control-Allow-Credentials": "true",
  };
}

const ONBOARDING_TOKEN_MAX_AGE_S = 86400;

/**
 * Verify the brewdock_onboarding HMAC token and extract the userId.
 * Token format: userId:timestamp:hmacSignature
 * HMAC is computed as: HMAC-SHA256(key=ONBOARDING_TOKEN_SECRET, data="onboarding:{userId}:{timestamp}")
 * @param token - The raw token string from the brewdock_onboarding cookie
 * @returns The userId if valid and not expired, or null otherwise
 */
function getUserIdFromOnboardingToken(token: string): string | null {
  if (!ONBOARDING_TOKEN_SECRET) {
    throw new Error("ONBOARDING_TOKEN_SECRET is not set");
  }

  const parts = token.split(":");
  if (parts.length !== 3) return null;

  const [userId, timestamp, providedHmac] = parts;
  if (!userId || !timestamp || !providedHmac) return null;

  // Check token isn't expired
  const tokenAge = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (isNaN(tokenAge) || tokenAge > ONBOARDING_TOKEN_MAX_AGE_S) return null;

  // Compute expected HMAC and timing-safe compare
  const expectedHmac = createHmac("sha256", ONBOARDING_TOKEN_SECRET)
    .update(`onboarding:${userId}:${timestamp}`)
    .digest("hex");

  const expected = Buffer.from(expectedHmac, "utf-8");
  const provided = Buffer.from(providedHmac, "utf-8");

  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  return userId;
}

// ============================================================================
// ENDPOINT
// ============================================================================

interface TriggerCallResponse {
  success: boolean;
  code?: DashboardErrorCode;
  error?: string;
}

/**
 * POST handler: verify session, forward to voice pipeline, return result.
 * @param request - The incoming Next.js request
 * @returns JSON response with success/error and CORS headers
 */
export async function POST(request: NextRequest): Promise<NextResponse<TriggerCallResponse>> {
  const corsHeaders = getCorsHeaders();

  try {
    if (!VOICE_PIPELINE_URL) {
      throw new Error("NEXT_PUBLIC_VOICE_PIPELINE_URL is not set");
    }
    if (!INTERNAL_API_KEY) {
      throw new Error("INTERNAL_API_KEY is not set");
    }

    const cookieStore = await cookies();
    let userId: string | null = null;

    const supabase = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      userId = user.id;
    }

    if (!userId) {
      const onboardingToken = cookieStore.get("brewdock_onboarding")?.value;
      if (onboardingToken) {
        userId = getUserIdFromOnboardingToken(onboardingToken);
      }
    }

    if (!userId) {
      return errorResponse("UNAUTHORIZED", 401, corsHeaders);
    }

    const response = await fetch(`${VOICE_PIPELINE_URL}/trigger-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${INTERNAL_API_KEY}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.success) {
      console.error("[trigger-call]", { status: response.status, result });
      const { code, message } = mapDashboardErrorDetails(
        result,
        "call-trigger",
        "CALL_TRIGGER_FAILED"
      );
      return NextResponse.json(
        { success: false, code, error: message },
        { status: response.status || 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (err) {
    console.error("[trigger-call]", err);
    const { code, message } = mapDashboardErrorDetails(
      err,
      "call-trigger",
      "CALL_TRIGGER_FAILED"
    );
    return NextResponse.json(
      { success: false, code, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}

function errorResponse(
  code: DashboardErrorCode,
  status: number,
  headers: Record<string, string>
): NextResponse<TriggerCallResponse> {
  return NextResponse.json(
    { success: false, code, error: getDashboardErrorMessage(code) },
    { status, headers }
  );
}
