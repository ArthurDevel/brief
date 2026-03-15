/**
 * API route for user memory entries (GET, PUT, DELETE).
 *
 * Memory entries are freeform markdown content the voice assistant
 * remembers across calls (e.g., preferences, common contacts).
 *
 * Responsibilities:
 * - GET: list all memory entries for the authenticated user
 * - PUT: insert a new entry or update an existing entry by id
 * - DELETE: remove a memory entry by id
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
 * @returns JSON array of { id, content, createdAt }
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
    .select("id, content, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message } as unknown as MemoryEntry[], { status: 500 });
  }

  const entries: MemoryEntry[] = (data ?? []).map((row) => ({
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
  }));

  return NextResponse.json(entries);
}

/**
 * Creates a new memory entry or updates an existing one.
 * Body: { content: string } to insert, or { id: string, content: string } to update.
 * @param request - The incoming request
 * @returns The saved memory entry
 */
export async function PUT(request: NextRequest): Promise<NextResponse<MemoryEntry | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id, content } = body as { id?: string; content?: string };

  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "content is required and must be a string" }, { status: 400 });
  }

  // Update existing entry
  if (id) {
    const { data, error } = await supabase
      .from("user_memory")
      .update({ content })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, content, created_at")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Entry not found" }, { status: 500 });
    }

    return NextResponse.json({ id: data.id, content: data.content, createdAt: data.created_at });
  }

  // Insert new entry
  const { data, error } = await supabase
    .from("user_memory")
    .insert({ user_id: user.id, content })
    .select("id, content, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Failed to insert" }, { status: 500 });
  }

  return NextResponse.json({ id: data.id, content: data.content, createdAt: data.created_at });
}

/**
 * Deletes a memory entry by id.
 * Body: { id: string }
 * @param request - The incoming request
 * @returns Success confirmation
 */
export async function DELETE(request: NextRequest): Promise<NextResponse<{ deleted: boolean } | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id } = body as { id?: string };

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("user_memory")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
