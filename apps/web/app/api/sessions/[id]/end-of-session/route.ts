/**
 * API route for end-of-session processing.
 *
 * Handles post-session tasks triggered by the voice pipeline after a call
 * ends. Enriches email-related actions with metadata (subject, from) via
 * IMAP, then sends a summary email.
 *
 * Responsibilities:
 * - Authenticate via INTERNAL_API_KEY (service-to-service)
 * - Load session and verify it exists with ended_at set
 * - Load actions for the session
 * - Enrich email-referencing actions with subject/from metadata
 * - Load user email via Supabase admin API
 * - Send summary email via Resend (if there are actions)
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { sendSessionSummary } from "@/lib/resend/client";
import { retrieveSecret } from "@dublin/tools";
import {
  createImapConnection,
  closeImapConnection,
  fetchEmailMetaBatch,
} from "@dublin/email";
import type { EmailMetaRequest } from "@dublin/email";
import type { ActionRow } from "@dublin/tools";
import { getDefaultClassification } from "@dublin/tools/src/classification";

/** IMAP client type derived from createImapConnection return value. */
type ImapClient = Awaited<ReturnType<typeof createImapConnection>>;

// ============================================================================
// TYPES
// ============================================================================

interface EndOfSessionResult {
  emailSent: boolean;
}

/** Tool names that reference an email and should be enriched with metadata. */
const EMAIL_TOOL_NAMES = ["archive_email", "delete_email"];

// ============================================================================
// ENDPOINT
// ============================================================================

/**
 * Processes end-of-session tasks for a completed voice call session.
 * Enriches email-referencing actions with metadata, then sends a summary email.
 * @param request - The incoming request (body is empty)
 * @param context - Route params containing the session ID
 * @returns JSON with { emailSent: true/false }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<EndOfSessionResult | { error: string }>> {
  // Validate API key
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) {
    throw new Error("INTERNAL_API_KEY is not set");
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  const totalStart = Date.now();
  const log = (msg: string) => console.log(`[end-of-session] [${sessionId}] ${msg}`);

  log("Processing started");
  const supabase = createServiceRoleClient();

  // Load the session
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, user_id, ended_at")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!session.ended_at) {
    return NextResponse.json(
      { error: "Session has not ended yet" },
      { status: 400 }
    );
  }

  // Load actions for the session
  const { data: actionsData, error: actionsError } = await supabase
    .from("actions")
    .select(
      "id, user_id, session_id, tool_name, arguments, result, status, requires_approval, undo_recipe, undo_deadline, created_at, executed_at"
    )
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (actionsError) {
    return NextResponse.json({ error: actionsError.message }, { status: 500 });
  }

  const actions: ActionRow[] = (actionsData ?? []).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    sessionId: row.session_id as string,
    toolName: row.tool_name as ActionRow["toolName"],
    arguments: row.arguments as Record<string, unknown>,
    result: (row.result as Record<string, unknown>) ?? null,
    status: row.status as ActionRow["status"],
    requiresApproval: row.requires_approval as boolean,
    undoRecipe: (row.undo_recipe as ActionRow["undoRecipe"]) ?? null,
    undoDeadline: (row.undo_deadline as string) ?? null,
    createdAt: row.created_at as string,
    executedAt: (row.executed_at as string) ?? null,
  }));

  log(`Loaded ${actions.length} action(s)`);

  // No actions -- nothing to report
  if (actions.length === 0) {
    log("No actions, skipping enrichment and email");
    return NextResponse.json({ emailSent: false });
  }

  // Enrich email-referencing actions with subject/from metadata.
  // Wrapped in try/catch so IMAP failures do not block email sending.
  try {
    // Load IMAP credentials (same pattern as approve route)
    const { data: settings, error: settingsError } = await supabase
      .from("user_settings")
      .select("imap_host, imap_port, imap_user, imap_password_secret_id")
      .eq("user_id", session.user_id)
      .single();

    if (settingsError || !settings || !settings.imap_password_secret_id) {
      log("Skipping enrichment: IMAP settings not configured");
    } else {
      const imapStart = Date.now();
      const imapPassword = await retrieveSecret(supabase, settings.imap_password_secret_id);
      const imapClient = await createImapConnection({
        host: settings.imap_host,
        port: settings.imap_port,
        user: settings.imap_user,
        password: imapPassword,
      });
      log(`IMAP connected in ${Date.now() - imapStart}ms`);

      try {
        const enrichStart = Date.now();
        const enrichedActions = await enrichActionsWithEmailMeta(actions, imapClient, log);
        log(`Enrichment done in ${Date.now() - enrichStart}ms: ${enrichedActions.length} action(s) enriched`);

        // Update enriched actions in the DB concurrently
        const dbStart = Date.now();
        await Promise.all(enrichedActions.map((action) =>
          supabase
            .from("actions")
            .update({ arguments: action.arguments })
            .eq("id", action.id)
        ));
        log(`DB updates done in ${Date.now() - dbStart}ms`);
      } finally {
        await closeImapConnection(imapClient);
      }
    }
  } catch (error) {
    console.error(`[end-of-session] [${sessionId}] Enrichment failed, continuing:`, error);
  }

  // Get user email from Supabase auth
  const { data: userData, error: userError } =
    await supabase.auth.admin.getUserById(session.user_id);

  if (userError || !userData?.user?.email) {
    return NextResponse.json(
      { error: "Could not retrieve user email" },
      { status: 500 }
    );
  }

  // Filter out read-only actions (same as the dashboard)
  const visibleActions = actions.filter(
    (a) => getDefaultClassification(a.toolName) !== "read_only"
  );

  log(`${visibleActions.length} visible action(s) after filtering read-only`);

  if (visibleActions.length === 0) {
    log("No visible actions, skipping email");
    return NextResponse.json({ emailSent: false });
  }

  // Send the summary email
  const sendStart = Date.now();
  await sendSessionSummary(userData.user.email, sessionId, visibleActions);
  log(`Summary email sent to ${userData.user.email} in ${Date.now() - sendStart}ms`);

  log(`Total processing time: ${Date.now() - totalStart}ms`);
  return NextResponse.json({ emailSent: true });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Enriches actions that reference an email with subject/from metadata.
 * Builds a batch of requests and calls fetchEmailMetaBatch once, then merges
 * the results back into the action arguments.
 * @param actions - Array of action rows to enrich
 * @param imapClient - Connected ImapFlow client
 * @param log - Logging function for diagnostic output
 * @returns Array of actions whose arguments were updated (subset of input)
 */
async function enrichActionsWithEmailMeta(
  actions: ActionRow[],
  imapClient: ImapClient,
  log: (msg: string) => void
): Promise<ActionRow[]> {
  // Filter to candidate actions that need enrichment
  const candidates = actions.filter(
    (a) => EMAIL_TOOL_NAMES.includes(a.toolName)
      && a.arguments?.email_id
      && !(a.arguments.subject && a.arguments.from)
  );
  log(`${candidates.length} action(s) need enrichment out of ${actions.length} total`);

  if (candidates.length === 0) {
    return [];
  }

  // Build batch requests -- prefer messageId over uid when both are present
  const requests: EmailMetaRequest[] = candidates.map((action) => {
    const messageId = action.arguments.message_id as string | undefined;
    const emailId = action.arguments.email_id as string;

    if (messageId) {
      return { actionId: action.id, messageId };
    }
    return { actionId: action.id, uid: emailId };
  });

  // Single batch call for all lookups
  const results = await fetchEmailMetaBatch(imapClient, requests);
  log(`Batch returned ${results.size} result(s) for ${requests.length} request(s)`);

  // Merge results back into action arguments
  const enriched: ActionRow[] = [];
  for (const action of candidates) {
    const meta = results.get(action.id);
    if (meta) {
      action.arguments = {
        ...action.arguments,
        subject: meta.subject,
        from: meta.from,
      };
      enriched.push(action);
    } else {
      log(`No metadata found for action ${action.id} (${action.toolName})`);
    }
  }

  return enriched;
}
