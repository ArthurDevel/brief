/**
 * Looks up the user's most recent completed agent session.
 *
 * Responsibilities:
 * - Read the latest non-null `ended_at` from the shared `sessions` table
 * - Return null when the user has never completed a prior session
 * - Skip the in-flight session row (its ended_at is still null)
 */

import { createClient } from "@supabase/supabase-js";
import type { AgentEnv } from "./env.js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Fetches the end time of the user's most recent completed session.
 * The current in-flight session is skipped because its `ended_at` is null.
 * @param env - Agent environment config
 * @param userId - Supabase user ID for the WhatsApp caller
 * @returns The last completed session end time, or null when no prior session exists
 */
export async function getLastCallEndedAt(
  env: AgentEnv,
  userId: string
): Promise<Date | null> {
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("sessions")
    .select("ended_at")
    .eq("user_id", userId)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up last call end time: ${error.message}`);
  }

  if (!data?.ended_at) {
    return null;
  }

  return new Date(data.ended_at as string);
}
