/**
 * API route to approve a pending action.
 *
 * Loads the action, verifies ownership, retrieves the active email account
 * from user_email_accounts, and executes the action via the provider-agnostic
 * email client in @dublin/tools.
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Load active email account (with Vault-resolved passwords for custom accounts)
 * - Execute the action through the provider-agnostic facade
 * - Return ActionResult
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { getActiveEmailAccountRecord } from "@/lib/email-accounts";
import { executeAction } from "@dublin/tools";
import type { ActionResult } from "@dublin/tools";
import {
  getDashboardErrorMessage,
  type DashboardErrorCode,
} from "@/lib/errors/dashboardErrors";
import { mapDashboardErrorDetails } from "@/lib/errors/mapDashboardError";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Approves a pending action and triggers execution via the active email account.
 * @param request - The incoming request
 * @param context - Route params containing the action ID
 * @returns JSON response with ActionResult
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ActionResult | { code: DashboardErrorCode; error: string }>> {
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

  // Load active email account with resolved credentials
  const serviceClient = createServiceRoleClient();
  const emailAccount = await getActiveEmailAccountRecord(supabase, serviceClient, user.id);

  if (!emailAccount) {
    return errorResponse("EMAIL_ACCOUNT_REQUIRED", 400);
  }

  try {
    // Mark as approved first, then execute
    await supabase
      .from("actions")
      .update({ status: "approved" })
      .eq("id", actionId);

    const result = await executeAction(actionId, supabase, emailAccount);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[actions/approve]", error);
    const { code, message } = mapDashboardErrorDetails(
      error,
      "action-approve",
      "ACTION_EXECUTION_FAILED"
    );
    return NextResponse.json({ code, error: message }, { status: 500 });
  }
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
