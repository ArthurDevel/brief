/**
 * API route to convert a pending send_email or reply_email action into a mailbox draft.
 *
 * Loads the action, validates it is a pending send_email or reply_email,
 * retrieves the active email account from user_email_accounts, converts
 * the action to a draft via the provider-agnostic client, and marks it "converted".
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Validate tool_name and status BEFORE loading email account
 * - Load active email account (with Vault-resolved passwords for custom accounts)
 * - Convert to draft via provider-agnostic facade, close connection
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { getActiveEmailAccountRecord } from "@/lib/email-accounts";
import { convertActionToDraft } from "@dublin/tools";
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
 * Converts a pending send_email or reply_email action into a draft in the user's mailbox.
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

  // Load the action and verify ownership + validate BEFORE loading email account
  const { data: action, error: actionError } = await supabase
    .from("actions")
    .select("id, user_id, status, tool_name")
    .eq("id", actionId)
    .single();

  if (actionError || !action) {
    return errorResponse("ACTION_NOT_FOUND", 404);
  }

  if (action.user_id !== user.id) {
    return errorResponse("UNAUTHORIZED", 403);
  }

  if (action.tool_name !== "send_email" && action.tool_name !== "reply_email") {
    return errorResponse("ACTION_DRAFT_FAILED", 400);
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
    const result = await convertActionToDraft(actionId, supabase, emailAccount);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[actions/convert-to-draft]", error);
    const { code, message } = mapDashboardErrorDetails(
      error,
      "action-draft",
      "ACTION_DRAFT_FAILED"
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
