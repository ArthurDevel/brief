/**
 * API route for end-of-session processing.
 *
 * Handles post-session tasks triggered by the voice pipeline after a call
 * ends. Currently sends a summary email with all actions taken during the
 * session.
 *
 * Responsibilities:
 * - Authenticate via INTERNAL_API_KEY (service-to-service)
 * - Load session and verify it exists with ended_at set
 * - Load actions for the session
 * - Load user email via Supabase admin API
 * - Send summary email via Resend (if there are actions)
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { sendSessionSummary } from "@/lib/resend/client";
import type { ActionRow } from "@dublin/tools";

// ============================================================================
// TYPES
// ============================================================================

interface EndOfSessionResult {
  emailSent: boolean;
}

// ============================================================================
// ENDPOINT
// ============================================================================

/**
 * Processes end-of-session tasks for a completed voice call session.
 * Sends a summary email listing all actions taken during the session.
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

  // No actions -- nothing to report
  if (actions.length === 0) {
    return NextResponse.json({ emailSent: false });
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

  // Send the summary email
  await sendSessionSummary(userData.user.email, sessionId, actions);

  return NextResponse.json({ emailSent: true });
}
