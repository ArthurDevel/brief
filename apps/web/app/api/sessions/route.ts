/**
 * API route for listing call sessions.
 *
 * Returns sessions for the authenticated user ordered by started_at desc,
 * with an action count for each session.
 *
 * Responsibilities:
 * - Authenticate the request
 * - Query sessions table with action count
 * - Return array of SessionSummary DTOs
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { SessionSummary } from "@/lib/types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists sessions for the authenticated user, ordered by most recent first.
 * @param _request - The incoming request (unused)
 * @returns JSON array of SessionSummary DTOs
 */
export async function GET(_request: NextRequest): Promise<NextResponse<SessionSummary[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as SessionSummary[], { status: 401 });
  }

  // Fetch sessions with total action count
  const { data: sessions, error } = await supabase
    .from("sessions")
    .select("id, started_at, ended_at, duration_seconds, actions(count)")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false });

  // Fetch session IDs that have pending actions
  const { data: pendingRows } = await supabase
    .from("actions")
    .select("session_id")
    .eq("user_id", user.id)
    .eq("status", "pending");

  if (error) {
    return NextResponse.json({ error: error.message } as unknown as SessionSummary[], { status: 500 });
  }

  // Build a map of session_id -> pending action count
  const pendingCountMap = new Map<string, number>();
  for (const row of pendingRows ?? []) {
    const sid = row.session_id as string;
    pendingCountMap.set(sid, (pendingCountMap.get(sid) ?? 0) + 1);
  }

  const summaries: SessionSummary[] = (sessions ?? []).map((row) => ({
    id: row.id as string,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    durationSeconds: (row.duration_seconds as number) ?? null,
    actionCount: extractCount(row.actions),
    pendingActionCount: pendingCountMap.get(row.id as string) ?? 0,
  }));

  return NextResponse.json(summaries);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extracts the count from a Supabase aggregated relation.
 * @param actions - The actions relation result (array with count or number)
 * @returns The count of actions
 */
function extractCount(actions: unknown): number {
  if (Array.isArray(actions) && actions.length > 0) {
    return (actions[0] as { count: number }).count ?? 0;
  }
  return 0;
}
