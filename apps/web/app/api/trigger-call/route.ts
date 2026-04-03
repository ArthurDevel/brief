/**
 * Authenticated proxy for triggering an initial onboarding call.
 *
 * Verifies the user's Supabase session, then forwards the request
 * to the voice pipeline's /trigger-call endpoint with internal auth.
 *
 * Responsibilities:
 * - Verify Supabase auth session
 * - Forward POST to voice pipeline with INTERNAL_API_KEY
 * - Add CORS headers for cross-subdomain requests from the lander
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_PIPELINE_URL = process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const LANDER_URL = process.env.LANDER_URL;

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

  // Verify Supabase session
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
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
    body: JSON.stringify({ user_id: user.id }),
  });

  const result = await response.json();

  return NextResponse.json(result, { headers: corsHeaders });
}
