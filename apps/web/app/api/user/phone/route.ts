/**
 * API route for updating the user's phone number.
 *
 * PUT updates the phone_number column in user_settings. The phone number
 * is used for caller ID authentication when the user calls the voice gateway.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Validate the phone number format
 * - Update the phone_number in user_settings
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Updates the user's phone number.
 * @param request - The incoming request with { phoneNumber: string }
 * @returns JSON response confirming the update
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const phoneNumber = body.phoneNumber;

  if (!phoneNumber || typeof phoneNumber !== "string") {
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 });
  }

  // Basic phone number format check (must start with +)
  if (!phoneNumber.startsWith("+")) {
    return NextResponse.json(
      { error: "Phone number must be in international format (e.g. +1234567890)" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: user.id, phone_number: phoneNumber },
      { onConflict: "user_id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, phoneNumber });
}
