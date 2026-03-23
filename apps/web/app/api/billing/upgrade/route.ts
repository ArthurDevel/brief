/**
 * API route for upgrading a user's subscription plan to Pro.
 *
 * Authenticates the request via cookie-based Supabase client, then uses
 * the service role client to upsert the subscription (RLS is select-only).
 *
 * Responsibilities:
 * - Authenticate the request
 * - Upsert the user's subscription to plan = "pro"
 * - Return UpgradeResponse DTO
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/client";
import type { UpgradeResponse } from "@/lib/types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Upgrades the authenticated user's plan to "pro".
 *
 * Idempotent -- calling as a pro user simply re-upserts and returns { plan: "pro" }.
 *
 * @param _request - The incoming request (body is ignored)
 * @returns JSON response with UpgradeResponse
 */
export async function POST(
  _request: NextRequest
): Promise<NextResponse<UpgradeResponse>> {
  // Authenticate via cookie-based client
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { plan: "free", error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Use service role client to bypass RLS (subscriptions table is select-only for users)
  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("subscriptions")
    .upsert({ user_id: user.id, plan: "pro" }, { onConflict: "user_id" });

  if (error) {
    return NextResponse.json(
      { plan: "free", error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ plan: "pro" });
}
