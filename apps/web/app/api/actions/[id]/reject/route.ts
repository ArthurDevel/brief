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
import {
  getDashboardErrorMessage,
  type DashboardErrorCode,
} from "@/lib/errors/dashboardErrors";

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
): Promise<NextResponse<{ success: boolean } | { code: DashboardErrorCode; error: string }>> {
  const { id: actionId } = await params;
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse("UNAUTHORIZED", 401);
  }

  // Load the action and verify ownership
  const { data: action, error: actionError } = await supabase
    .from("actions")
    .select("id, user_id, status")
    .eq("id", actionId)
    .single();

  if (actionError || !action) {
    return errorResponse("ACTION_NOT_FOUND", 404);
  }

  if (action.user_id !== user.id) {
    return errorResponse("UNAUTHORIZED", 403);
  }

  if (action.status !== "pending") {
    return errorResponse("ACTION_ALREADY_HANDLED", 400);
  }

  // Update status to rejected
  const { error: updateError } = await supabase
    .from("actions")
    .update({ status: "rejected" })
    .eq("id", actionId);

  if (updateError) {
    console.error("[actions/reject]", updateError);
    return errorResponse("ACTION_REJECT_FAILED", 500);
  }

  return NextResponse.json({ success: true });
}

function errorResponse(
  code: DashboardErrorCode,
  status: number
): NextResponse<{ code: DashboardErrorCode; error: string }> {
  return NextResponse.json(
    { code, error: getDashboardErrorMessage(code) },
    { status }
  );
}
