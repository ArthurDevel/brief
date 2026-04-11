/**
 * Public token-scoped API for minimal session review data.
 *
 * This route accepts a short-lived session review token from a recap email and
 * returns only the small set of fields needed by the minimal review page.
 *
 * Responsibilities:
 * - Validate the session review token
 * - Load only the token-scoped session
 * - Return only non-read-only actions for that session
 * - Avoid returning full action arguments, transcript, settings, or account data
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import {
  touchSessionReviewToken,
  validateSessionReviewToken,
} from "@/lib/session-review-tokens";
import {
  isVisibleReviewAction,
  mapReviewAction,
  type SessionReviewResponse,
} from "@/lib/session-review";
import type { ToolName } from "@dublin/tools";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns minimal session review data for a valid one-hour token.
 * @param request - Incoming request with `token` query param
 * @returns Session review DTO or error
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<SessionReviewResponse | { error: string }>> {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const supabase = createServiceRoleClient();
  const tokenContext = await validateSessionReviewToken(supabase, token);

  if (!tokenContext) {
    return NextResponse.json({ error: "Invalid or expired review link" }, { status: 401 });
  }

  const cookieStore = await cookies();
  const authClient = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await authClient.auth.getUser();
  if (user && user.id !== tokenContext.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, user_id, started_at, ended_at, duration_seconds")
    .eq("id", tokenContext.sessionId)
    .eq("user_id", tokenContext.userId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const { data: actionsData, error: actionsError } = await supabase
    .from("actions")
    .select("id, user_id, session_id, tool_name, arguments, status, created_at")
    .eq("user_id", tokenContext.userId)
    .eq("session_id", tokenContext.sessionId)
    .order("created_at", { ascending: true });

  if (actionsError) {
    return NextResponse.json({ error: actionsError.message }, { status: 500 });
  }

  await touchSessionReviewToken(supabase, tokenContext.tokenId);

  const actions = (actionsData ?? [])
    .filter((row) => isVisibleReviewAction(row.tool_name as ToolName))
    .map((row) => mapReviewAction(row));

  return NextResponse.json({
    sessionId: session.id as string,
    startedAt: session.started_at as string,
    endedAt: (session.ended_at as string) ?? null,
    durationSeconds: (session.duration_seconds as number) ?? null,
    actions,
  });
}
