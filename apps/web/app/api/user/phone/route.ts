/**
 * API route for updating the user's phone number.
 *
 * PUT updates the phone JSONB column in user_settings. The phone number
 * is used for caller ID authentication when the user calls the voice gateway.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Validate the phone number format (must start with +)
 * - Upsert the phone JSONB object in user_settings
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { UserPhone } from "@/lib/types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Updates the user's phone number and country code.
 * @param request - The incoming request with { number: string, countryCode: string }
 * @returns JSON response confirming the update with the saved phone object
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const number = body.number;
  const countryCode = body.countryCode;

  if (!number || typeof number !== "string") {
    return NextResponse.json({ error: "number is required" }, { status: 400 });
  }

  if (!countryCode || typeof countryCode !== "string") {
    return NextResponse.json({ error: "countryCode is required" }, { status: 400 });
  }

  if (!number.startsWith("+")) {
    return NextResponse.json(
      { error: "Phone number must be in international format (e.g. +1234567890)" },
      { status: 400 }
    );
  }

  const phone: UserPhone = { number, countryCode };

  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: user.id, phone },
      { onConflict: "user_id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, phone });
}
