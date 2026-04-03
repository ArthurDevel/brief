/**
 * Authenticated proxy for triggering an initial onboarding call.
 *
 * Verifies the user's identity via Supabase session or onboarding token,
 * then forwards the request to the voice pipeline's /trigger-call endpoint.
 *
 * Responsibilities:
 * - Verify auth: Supabase session first, onboarding_token JWT as fallback
 * - Forward POST to voice pipeline with INTERNAL_API_KEY
 * - Add CORS headers for cross-subdomain requests from the lander
 */

import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";

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

/**
 * Verify the onboarding_token JWT cookie and extract the userId.
 * Used as a fallback when the user has no Supabase session (e.g. during
 * onboarding before email confirmation).
 * @param token - The raw JWT string from the onboarding_token cookie
 * @returns The userId from the token payload, or null if invalid/missing
 */
async function getUserIdFromOnboardingToken(token: string): Promise<string | null> {
  if (!ONBOARDING_TOKEN_SECRET) {
    throw new Error("ONBOARDING_TOKEN_SECRET is not set");
  }

  try {
    const secret = new TextEncoder().encode(ONBOARDING_TOKEN_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.userId as string | undefined;
    return userId ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// ENDPOINT
// ============================================================================

interface TriggerCallResponse {
  success: boolean;
  error?: string;
}

/**
 * POST handler: verify session, forward to voice pipeline, return result.
 * @param request - The incoming Next.js request
 * @returns JSON response with success/error and CORS headers
 */
export async function POST(request: NextRequest): Promise<NextResponse<TriggerCallResponse>> {
  const corsHeaders = getCorsHeaders();

  if (!VOICE_PIPELINE_URL) {
    throw new Error("NEXT_PUBLIC_VOICE_PIPELINE_URL is not set");
  }
  if (!INTERNAL_API_KEY) {
    throw new Error("INTERNAL_API_KEY is not set");
  }

  // Resolve userId: try Supabase session first, fall back to onboarding token
  const cookieStore = await cookies();
  let userId: string | null = null;

  // Try Supabase session
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    userId = user.id;
  }

  // Fall back to onboarding_token cookie (pre-email-confirmation flow)
  if (!userId) {
    const onboardingToken = cookieStore.get("onboarding_token")?.value;
    if (onboardingToken) {
      userId = await getUserIdFromOnboardingToken(onboardingToken);
    }
  }

  if (!userId) {
    return NextResponse.json(
      { success: false, error: "unauthorized" },
      { status: 401, headers: corsHeaders }
    );
  }

  // Forward to voice pipeline
  const response = await fetch(`${VOICE_PIPELINE_URL}/trigger-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${INTERNAL_API_KEY}`,
    },
    body: JSON.stringify({ user_id: userId }),
  });

  const result = await response.json();

  return NextResponse.json(result, { headers: corsHeaders });
}
