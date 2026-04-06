/**
 * API route to undo an executed action.
 *
 * Loads the action, verifies ownership, retrieves the active email account
 * from user_email_accounts, and undoes the action via the provider-agnostic
 * email client in @dublin/tools.
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Load active email account (with Vault-resolved passwords for custom accounts)
 * - Undo the action through the provider-agnostic facade
 * - Return UndoResult
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { getActiveEmailAccountRecord } from "@/lib/email-accounts";
import { undoAction } from "@dublin/tools";
import type { UndoResult } from "@dublin/tools";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Undoes an executed action by reversing it via the active email account.
 * @param request - The incoming request
 * @param context - Route params containing the action ID
 * @returns JSON response with UndoResult
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<UndoResult | { error: string }>> {
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

  if (action.status !== "executed") {
    return NextResponse.json({ error: `Action is not executed (status: ${action.status})` }, { status: 400 });
  }

  // Load active email account with resolved credentials
  const serviceClient = createServiceRoleClient();
  const emailAccount = await getActiveEmailAccountRecord(supabase, serviceClient, user.id);

  if (!emailAccount) {
    return NextResponse.json({ error: "No active email account configured" }, { status: 400 });
  }

  try {
    const result = await undoAction(actionId, supabase, emailAccount);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to undo action";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
