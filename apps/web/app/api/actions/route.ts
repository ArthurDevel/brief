/**
 * API route for listing actions.
 *
 * Returns actions for the authenticated user, optionally filtered by status.
 * By default, excludes read-only tool actions (e.g. list_inbox, search_emails).
 * Maps snake_case DB columns to camelCase ActionRow DTOs.
 *
 * Responsibilities:
 * - Authenticate the request
 * - Query the actions table with optional status filter
 * - Exclude read-only actions unless ?includeReadOnly=true
 * - Return array of ActionRow DTOs
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { ActionRow, ToolName } from "@dublin/tools";
import { getDefaultClassification } from "@dublin/tools";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists actions for the authenticated user, optionally filtered by status.
 * @param request - The incoming request with optional `status` query param
 * @returns JSON array of ActionRow DTOs
 */
export async function GET(request: NextRequest): Promise<NextResponse<ActionRow[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as ActionRow[], { status: 401 });
  }

  const status = request.nextUrl.searchParams.get("status");
  const includeReadOnly = request.nextUrl.searchParams.get("includeReadOnly") === "true";

  let query = supabase
    .from("actions")
    .select("id, user_id, session_id, tool_name, arguments, result, status, requires_approval, undo_recipe, undo_deadline, created_at, executed_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message } as unknown as ActionRow[], { status: 500 });
  }

  let actions: ActionRow[] = (data ?? []).map(mapActionRow);

  // Filter out read-only actions unless explicitly requested
  if (!includeReadOnly) {
    actions = actions.filter(
      (a) => getDefaultClassification(a.toolName as ToolName) !== "read_only"
    );
  }

  return NextResponse.json(actions);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Maps a snake_case DB row to a camelCase ActionRow DTO.
 * @param row - Raw database row
 * @returns ActionRow DTO
 */
function mapActionRow(row: Record<string, unknown>): ActionRow {
  return {
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
  };
}
