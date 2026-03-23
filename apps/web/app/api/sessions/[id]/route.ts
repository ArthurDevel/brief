/**
 * API route for a single session detail.
 *
 * Returns the full session with transcript and associated actions
 * for the authenticated user.
 *
 * Responsibilities:
 * - Authenticate the request and verify session ownership
 * - Load session data including transcript
 * - Load associated actions
 * - Return SessionDetail DTO
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { SessionDetail, TranscriptEntry } from "@/lib/types";
import type { ActionRow, ToolName } from "@dublin/tools";
import { getDefaultClassification } from "@dublin/tools";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns full session detail with transcript and actions.
 * @param request - The incoming request
 * @param context - Route params containing the session ID
 * @returns JSON response with SessionDetail
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<SessionDetail | { error: string }>> {
  const { id: sessionId } = await params;
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load the session
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, user_id, started_at, ended_at, duration_seconds, transcript")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Load associated actions
  const { data: actionsData, error: actionsError } = await supabase
    .from("actions")
    .select("id, user_id, session_id, tool_name, arguments, result, status, requires_approval, undo_recipe, undo_deadline, created_at, executed_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (actionsError) {
    return NextResponse.json({ error: actionsError.message }, { status: 500 });
  }

  const allActions: ActionRow[] = (actionsData ?? []).map((row) => ({
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

  // Exclude read-only actions (e.g. list_inbox, search_emails)
  const actions = allActions.filter(
    (a) => getDefaultClassification(a.toolName as ToolName) !== "read_only"
  );

  const transcript: TranscriptEntry[] = Array.isArray(session.transcript)
    ? (session.transcript as TranscriptEntry[])
    : [];

  const detail: SessionDetail = {
    id: session.id,
    startedAt: session.started_at,
    endedAt: session.ended_at ?? null,
    durationSeconds: session.duration_seconds ?? null,
    transcript,
    actions,
  };

  return NextResponse.json(detail);
}
