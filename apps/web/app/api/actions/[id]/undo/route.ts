/**
 * API route to undo an executed action.
 *
 * Loads the action, verifies ownership, retrieves IMAP credentials
 * from Vault, opens an IMAP connection, undoes the action via
 * @dublin/tools, then closes the connection.
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Load IMAP credentials from user_settings + Vault
 * - Open IMAP connection and undo the action
 * - Close IMAP connection and return UndoResult
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { undoAction, retrieveSecret } from "@dublin/tools";
import { createImapConnection, closeImapConnection } from "@dublin/email";
import type { UndoResult } from "@dublin/tools";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Undoes an executed action by reversing it via IMAP.
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

  // Load user settings to get IMAP credential secret ID
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

  // Retrieve IMAP password from Vault
  const imapPassword = await retrieveSecret(supabase, settings.imap_password_secret_id);

  // Open IMAP connection, undo, close
  const imapClient = await createImapConnection({
    host: settings.imap_host,
    port: settings.imap_port,
    user: settings.imap_user,
    password: imapPassword,
  });

  try {
    const result = await undoAction(actionId, supabase, imapClient);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to undo action";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await closeImapConnection(imapClient);
  }
}
