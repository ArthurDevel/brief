/**
 * Supabase service role client factory for the voice gateway.
 *
 * Creates a Supabase client using the service role key, which bypasses
 * Row Level Security. Used for server-side operations like session
 * management, action processing, and credential retrieval.
 *
 * Responsibilities:
 * - Create a Supabase client with service role permissions
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Creates a Supabase client using the service role key.
 * Bypasses RLS for server-side operations.
 * @returns Supabase client with service role permissions
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is not set in environment");
  }
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set in environment");
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
