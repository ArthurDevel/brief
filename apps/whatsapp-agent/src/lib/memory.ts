/**
 * Loads the user's saved memory entries for prompt injection.
 *
 * Responsibilities:
 * - Read freeform markdown entries from the shared user_memory table
 * - Return entries ordered oldest-first for stable bullet ordering
 */

import { createClient } from "@supabase/supabase-js";
import type { AgentEnv } from "./env.js";

// ============================================================================
// TYPES
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: string;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Fetches all memory entries for the given user.
 * @param env - Agent environment config
 * @param userId - Supabase user ID for the WhatsApp caller
 * @returns Memory entries in oldest-first order
 */
export async function getUserMemoryEntries(
  env: AgentEnv,
  userId: string
): Promise<MemoryEntry[]> {
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("user_memory")
    .select("id, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load user memory: ${error.message}`);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((row) => ({
    id: String(row.id),
    content: String(row.content),
  }));
}
