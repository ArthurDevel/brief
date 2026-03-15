/**
 * API route for listing user feature requests.
 *
 * Returns all feature requests submitted by the authenticated user,
 * ordered by creation date (newest first).
 *
 * Responsibilities:
 * - Authenticate the request
 * - Query feature_requests table for the user
 * - Return array of FeatureRequest DTOs
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { FeatureRequest } from "@/lib/types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists all feature requests for the authenticated user.
 * @param _request - The incoming request (unused)
 * @returns JSON array of feature requests
 */
export async function GET(_request: NextRequest): Promise<NextResponse<FeatureRequest[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" } as unknown as FeatureRequest[],
      { status: 401 }
    );
  }

  const { data, error } = await supabase
    .from("feature_requests")
    .select("id, description, source, session_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message } as unknown as FeatureRequest[],
      { status: 500 }
    );
  }

  const requests: FeatureRequest[] = (data ?? []).map(mapFeatureRequestRow);

  return NextResponse.json(requests);
}

/**
 * Creates a new feature request from the dashboard.
 * @param request - The incoming request with JSON body { description: string }
 * @returns JSON response with the created FeatureRequest
 */
export async function POST(request: NextRequest): Promise<NextResponse<FeatureRequest | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const description = body?.description;

  if (!description || typeof description !== "string" || description.trim().length === 0) {
    return NextResponse.json({ error: "Description is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("feature_requests")
    .insert({
      user_id: user.id,
      description: description.trim(),
      source: "dashboard",
    })
    .select("id, description, source, session_id, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create feature request" },
      { status: 500 }
    );
  }

  return NextResponse.json(mapFeatureRequestRow(data), { status: 201 });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Maps a snake_case DB row to a camelCase FeatureRequest DTO.
 * @param row - Raw database row
 * @returns FeatureRequest DTO
 */
function mapFeatureRequestRow(row: Record<string, unknown>): FeatureRequest {
  return {
    id: row.id as string,
    description: row.description as string,
    source: row.source as "voice" | "dashboard",
    sessionId: (row.session_id as string) ?? null,
    createdAt: row.created_at as string,
  };
}
