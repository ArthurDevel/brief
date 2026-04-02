/**
 * API route to convert a pending send_email or reply_email action into a mailbox draft.
 *
 * Loads the action, validates it is a pending send_email or reply_email,
 * retrieves IMAP credentials from Vault, opens an IMAP connection, saves
 * the draft via IMAP APPEND, and marks the action as "converted".
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Validate tool_name and status BEFORE opening IMAP connection
 * - Load IMAP credentials from user_settings + Vault (no SMTP needed)
 * - Open IMAP connection, convert to draft, close connection
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { convertActionToDraft, retrieveSecret } from "@dublin/tools";
import { createImapConnection, closeImapConnection } from "@dublin/email";
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

  // Load the action and verify ownership + validate BEFORE opening IMAP
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

  // Load IMAP credentials (no SMTP needed for draft saving)
  const { data: settings, error: settingsError } = await supabase
    .from("user_settings")
    .select("imap_host, imap_port, imap_user, imap_password_secret_id")
    .eq("user_id", user.id)
    .single();

  if (settingsError || !settings) {
    return NextResponse.json({ error: "Email settings not configured" }, { status: 400 });
  }

  if (!settings.imap_password_secret_id) {
    return NextResponse.json({ error: "IMAP password not configured" }, { status: 400 });
  }

  const imapPassword = await retrieveSecret(supabase, settings.imap_password_secret_id);

  // Open IMAP connection, convert to draft, close
  const imapClient = await createImapConnection({
    host: settings.imap_host,
    port: settings.imap_port,
    user: settings.imap_user,
    password: imapPassword,
  });

  try {
    const result = await convertActionToDraft(actionId, supabase, imapClient);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to convert action to draft";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await closeImapConnection(imapClient);
  }
}
