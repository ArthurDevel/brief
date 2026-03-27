/**
 * Bulk approve/reject API endpoint.
 *
 * Accepts an array of action IDs and an operation (approve or reject).
 * For reject: performs a single DB update. For approve: opens one IMAP
 * connection and delegates to bulkExecuteActions for batched execution.
 *
 * Responsibilities:
 * - Authenticate the request and verify ownership of all actions
 * - Validate input (actionIds array, operation string)
 * - Reject path: single DB update, return counts
 * - Approve path: load credentials, open IMAP, call bulkExecuteActions, close
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { bulkExecuteActions, retrieveSecret } from "@dublin/tools";
import { createImapConnection, closeImapConnection } from "@dublin/email";
import type { BulkActionResponse } from "@dublin/tools";
import type { SmtpConfig } from "@dublin/email";

const VALID_OPERATIONS = ["approve", "reject"] as const;
type Operation = (typeof VALID_OPERATIONS)[number];

interface BulkRequestBody {
  actionIds: string[];
  operation: Operation;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handles bulk approve or reject of actions.
 * @param request - The incoming request with body { actionIds: string[], operation: "approve" | "reject" }
 * @returns JSON response with BulkActionResponse or error
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<BulkActionResponse | { error: string }>> {
  // Auth
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse and validate body
  const body = await parseRequestBody(request);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid request body. Expected { actionIds: string[], operation: \"approve\" | \"reject\" }" },
      { status: 400 }
    );
  }

  const { actionIds, operation } = body;

  // Load all actions in one query to verify ownership
  const { data: actions, error: loadError } = await supabase
    .from("actions")
    .select("id, user_id, status")
    .in("id", actionIds);

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  // If any action belongs to a different user, reject the entire request
  const foreignAction = (actions ?? []).find((a) => a.user_id !== user.id);
  if (foreignAction) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Route to the correct handler
  if (operation === "reject") {
    return handleReject(actionIds, actions ?? [], supabase, user.id);
  }

  return handleApprove(actionIds, supabase, user.id);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses and validates the request body.
 * @param request - The incoming request
 * @returns Validated body or null if invalid
 */
async function parseRequestBody(request: NextRequest): Promise<BulkRequestBody | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;

  const { actionIds, operation } = raw as Record<string, unknown>;

  // actionIds must be a non-empty array of strings
  if (!Array.isArray(actionIds) || actionIds.length === 0) return null;
  if (!actionIds.every((id) => typeof id === "string")) return null;

  // operation must be "approve" or "reject"
  if (!VALID_OPERATIONS.includes(operation as Operation)) return null;

  return { actionIds: actionIds as string[], operation: operation as Operation };
}

/**
 * Handles the reject operation: single DB update, returns counts.
 * @param actionIds - The action IDs to reject
 * @param loadedActions - Actions already loaded for ownership check
 * @param supabase - Supabase client
 * @param userId - Authenticated user ID
 * @returns JSON response with BulkActionResponse
 */
async function handleReject(
  actionIds: string[],
  loadedActions: { id: string; user_id: string; status: string }[],
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<NextResponse<BulkActionResponse>> {
  // Single DB update -- only pending actions are affected
  const { data: updated, error } = await supabase
    .from("actions")
    .update({ status: "rejected" })
    .in("id", actionIds)
    .eq("status", "pending")
    .eq("user_id", userId)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: error.message } as unknown as BulkActionResponse,
      { status: 500 }
    );
  }

  const rejectedIds = new Set((updated ?? []).map((r) => r.id));
  const pendingCount = loadedActions.filter((a) => a.status === "pending").length;
  const skippedCount = loadedActions.length - pendingCount;

  const results = loadedActions.map((a) => ({
    actionId: a.id as string,
    status: rejectedIds.has(a.id) ? ("executed" as const) : ("skipped" as const),
    error: null,
  }));

  return NextResponse.json({
    total: loadedActions.length,
    succeeded: rejectedIds.size,
    failed: 0,
    skipped: skippedCount,
    results,
  });
}

/**
 * Handles the approve operation: loads credentials, opens IMAP, calls bulkExecuteActions.
 * @param actionIds - The action IDs to approve
 * @param supabase - Supabase client
 * @param userId - Authenticated user ID
 * @returns JSON response with BulkActionResponse
 */
async function handleApprove(
  actionIds: string[],
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<NextResponse<BulkActionResponse | { error: string }>> {
  // Load user settings to get credential secret IDs
  const { data: settings, error: settingsError } = await supabase
    .from("user_settings")
    .select("imap_host, imap_port, imap_user, imap_password_secret_id, smtp_host, smtp_port, smtp_user, smtp_password_secret_id")
    .eq("user_id", userId)
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

  // Open one IMAP connection for the entire batch
  const imapClient = await createImapConnection({
    host: settings.imap_host,
    port: settings.imap_port,
    user: settings.imap_user,
    password: imapPassword,
  });

  try {
    const response = await bulkExecuteActions(actionIds, supabase, imapClient, smtpConfig);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute bulk actions";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await closeImapConnection(imapClient);
  }
}
