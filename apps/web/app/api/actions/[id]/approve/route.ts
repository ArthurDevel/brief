/**
 * API route to approve a pending action.
 *
 * Loads the action, verifies ownership, retrieves IMAP/SMTP credentials
 * from Vault, opens an IMAP connection, executes the action via
 * @dublin/tools, then closes the connection.
 *
 * Responsibilities:
 * - Authenticate the request and verify action ownership
 * - Load IMAP/SMTP credentials from user_settings + Vault
 * - Open IMAP connection and execute the action
 * - Close IMAP connection and return ActionResult
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { executeAction, retrieveSecret } from "@dublin/tools";
import { createImapConnection, closeImapConnection } from "@dublin/email";
import type { ActionResult } from "@dublin/tools";
import type { SmtpConfig } from "@dublin/email";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Approves a pending action and triggers execution via IMAP.
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

  // Load user settings to get credential secret IDs
  const { data: settings, error: settingsError } = await supabase
    .from("user_settings")
    .select("imap_host, imap_port, imap_user, imap_password_secret_id, smtp_host, smtp_port, smtp_user, smtp_password_secret_id")
    .eq("user_id", user.id)
    .single();

  if (settingsError || !settings) {
    return NextResponse.json({ error: "Email settings not configured" }, { status: 400 });
  }

  if (!settings.imap_password_secret_id) {
    return NextResponse.json({ error: "IMAP password not configured" }, { status: 400 });
  }

  // Retrieve secrets from Vault
  const imapPassword = await retrieveSecret(supabase, settings.imap_password_secret_id);

  let smtpPassword: string | null = null;
  if (settings.smtp_password_secret_id) {
    smtpPassword = await retrieveSecret(supabase, settings.smtp_password_secret_id);
  }

  const smtpConfig: SmtpConfig = {
    host: settings.smtp_host,
    port: settings.smtp_port,
    user: settings.smtp_user,
    password: smtpPassword ?? "",
  };

  // Open IMAP connection, execute, close
  const imapClient = await createImapConnection({
    host: settings.imap_host,
    port: settings.imap_port,
    user: settings.imap_user,
    password: imapPassword,
  });

  try {
    // Mark as approved first, then execute
    await supabase
      .from("actions")
      .update({ status: "approved" })
      .eq("id", actionId);

    const result = await executeAction(actionId, supabase, imapClient, smtpConfig);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute action";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await closeImapConnection(imapClient);
  }
}
