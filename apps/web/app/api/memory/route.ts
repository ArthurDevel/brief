/**
 * API route for user memory entries (GET and PUT).
 *
 * Memory entries are key-value pairs that the voice assistant remembers
 * across calls (e.g., preferred greeting, common contacts).
 *
 * Responsibilities:
 * - GET: list all memory entries for the authenticated user
 * - PUT: upsert memory entries (replaces all entries)
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { MemoryEntry } from "@/lib/types";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists all memory entries for the authenticated user.
 * @param _request - The incoming request (unused)
 * @returns JSON array of memory entries
 */
export async function GET(_request: NextRequest): Promise<NextResponse<MemoryEntry[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as MemoryEntry[], { status: 401 });
  }

  const { data, error } = await supabase
    .from("user_memory")
    .select("key, value")
    .eq("user_id", user.id)
    .order("key");

  if (error) {
    return NextResponse.json({ error: error.message } as unknown as MemoryEntry[], { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

/**
 * Upserts memory entries for the authenticated user.
 * Deletes all existing entries and inserts the provided ones.
 * @param request - The incoming request with { entries: MemoryEntry[] }
 * @returns JSON array of the saved memory entries
 */
export async function PUT(request: NextRequest): Promise<NextResponse<MemoryEntry[] | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" } as unknown as MemoryEntry[], { status: 401 });
  }

  const body = await request.json();
  const entries: MemoryEntry[] = body.entries;

  if (!Array.isArray(entries)) {
    return NextResponse.json(
      { error: "entries must be an array" } as unknown as MemoryEntry[],
      { status: 400 }
    );
  }

  // Delete all existing entries for this user
  const { error: deleteError } = await supabase
    .from("user_memory")
    .delete()
    .eq("user_id", user.id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message } as unknown as MemoryEntry[],
      { status: 500 }
    );
  }

  // Insert new entries (if any)
  if (entries.length > 0) {
    const rows = entries.map((entry) => ({
      user_id: user.id,
      key: entry.key,
      value: entry.value,
    }));

    const { error: insertError } = await supabase
      .from("user_memory")
      .insert(rows);

    if (insertError) {
      return NextResponse.json(
        { error: insertError.message } as unknown as MemoryEntry[],
        { status: 500 }
      );
    }
  }

  return NextResponse.json(entries);
}
