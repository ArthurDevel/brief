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
): Promise<NextResponse<ActionResult | { error: string }>> {
  const { id: actionId } = await params;
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load the action and verify ownership + validate BEFORE loading email account
  const { data: action, error: actionError } = await supabase
    .from("actions")
    .select("id, user_id, status, tool_name")
    .eq("id", actionId)
    .single();

  if (actionError || !action) {
    return NextResponse.json({ error: "Action not found" }, { status: 404 });
  }

  if (action.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  if (action.tool_name !== "send_email" && action.tool_name !== "reply_email") {
    return NextResponse.json({ error: `Action is not a send_email or reply_email action (tool_name: ${action.tool_name})` }, { status: 400 });
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
    const result = await convertActionToDraft(actionId, supabase, emailAccount);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to convert action to draft";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
