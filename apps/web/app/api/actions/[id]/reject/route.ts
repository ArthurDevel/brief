/**
 * API route to reject a pending action.
 *
 * Updates the action's status to "rejected" in the database.
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Update the action status to "rejected"
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Rejects a pending action by setting its status to "rejected".
 * @param request - The incoming request
 * @param context - Route params containing the action ID
 * @returns JSON response with success boolean
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ success: boolean } | { error: string }>> {
  const { id: actionId } = await params;
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load the action and verify ownership
  const { data: action, error: actionError } = await supabase
    .from("actions")
    .select("id, user_id, status")
    .eq("id", actionId)
    .single();

  if (actionError || !action) {
    return NextResponse.json({ error: "Action not found" }, { status: 404 });
  }

  if (action.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  if (action.status !== "pending") {
    return NextResponse.json({ error: `Action is not pending (status: ${action.status})` }, { status: 400 });
  }

  // Update status to rejected
  const { error: updateError } = await supabase
    .from("actions")
    .update({ status: "rejected" })
    .eq("id", actionId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
