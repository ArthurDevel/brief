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
): Promise<NextResponse<ActionResult | { error: string }>> {
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

  // Load active email account with resolved credentials
  const serviceClient = createServiceRoleClient();
  const emailAccount = await getActiveEmailAccountRecord(supabase, serviceClient, user.id);

  if (!emailAccount) {
    return NextResponse.json({ error: "No active email account configured" }, { status: 400 });
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
    const message = error instanceof Error ? error.message : "Failed to execute action";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
