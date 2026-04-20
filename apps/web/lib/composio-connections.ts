/**
 * Helpers for reading and writing user-scoped Composio connection rows.
 *
 * Responsibilities:
 * - Load a user's saved Composio connection by toolkit
 * - Upsert connection state after callback completion
 * - Map raw database rows into stable UI DTOs
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComposioConnectionSummary } from "@/lib/types";

// ============================================================================
// TYPES
// ============================================================================

export interface UserComposioConnectionRow {
  connected_account_id: string | null;
  connected_at: string | null;
  external_user_id: string | null;
  last_error: string | null;
  provider: string;
  status: "connected" | "reconnect_required" | "pending" | "error";
  toolkit: string;
}

export interface UpsertUserComposioConnectionInput {
  userId: string;
  toolkit: string;
  status: "connected" | "reconnect_required" | "pending" | "error";
  connectedAccountId?: string | null;
  connectedAt?: string | null;
  externalUserId?: string | null;
  lastError?: string | null;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Loads a user's Composio connection for one toolkit.
 * @param supabase - Supabase client with user or service credentials
 * @param userId - Supabase auth user ID
 * @param toolkit - Toolkit slug, for example "gmail"
 * @returns The mapped connection summary, or null when no row exists
 */
export async function getUserComposioConnection(
  supabase: SupabaseClient,
  userId: string,
  toolkit: string
): Promise<ComposioConnectionSummary | null> {
  const { data, error } = await supabase
    .from("user_composio_connections")
    .select("toolkit, provider, connected_account_id, status, external_user_id, connected_at, last_error")
    .eq("user_id", userId)
    .eq("toolkit", toolkit)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return mapUserComposioConnectionRowToSummary(data as UserComposioConnectionRow);
}

/**
 * Creates or updates a user's Composio connection row.
 * @param supabase - Supabase client with user or service credentials
 * @param input - Fields to write to the connection row
 * @returns The updated connection summary
 */
export async function upsertUserComposioConnection(
  supabase: SupabaseClient,
  input: UpsertUserComposioConnectionInput
): Promise<ComposioConnectionSummary> {
  const existing = await getRawUserComposioConnection(supabase, input.userId, input.toolkit);

  const payload = {
    user_id: input.userId,
    toolkit: input.toolkit,
    provider: "composio",
    connected_account_id:
      input.connectedAccountId !== undefined
        ? input.connectedAccountId
        : existing?.connected_account_id ?? null,
    status: input.status,
    external_user_id:
      input.externalUserId !== undefined
        ? input.externalUserId
        : existing?.external_user_id ?? null,
    connected_at:
      input.connectedAt !== undefined
        ? input.connectedAt
        : existing?.connected_at ?? null,
    last_error:
      input.lastError !== undefined
        ? input.lastError
        : existing?.last_error ?? null,
  };

  const { data, error } = await supabase
    .from("user_composio_connections")
    .upsert(payload, { onConflict: "user_id,toolkit" })
    .select("toolkit, provider, connected_account_id, status, external_user_id, connected_at, last_error")
    .single();

  if (error) {
    throw error;
  }

  return mapUserComposioConnectionRowToSummary(data as UserComposioConnectionRow);
}

/**
 * Maps a raw connection row into the shared UI DTO.
 * @param row - Raw row data from user_composio_connections
 * @returns Stable UI DTO for the connection
 */
export function mapUserComposioConnectionRowToSummary(
  row: UserComposioConnectionRow
): ComposioConnectionSummary {
  return {
    toolkit: row.toolkit,
    provider: "composio",
    connectedAccountId: row.connected_account_id,
    status: row.status,
    externalUserId: row.external_user_id,
    connectedAt: row.connected_at,
    lastError: row.last_error,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads the raw Composio connection row for merge-style updates.
 * @param supabase - Supabase client with user or service credentials
 * @param userId - Supabase auth user ID
 * @param toolkit - Toolkit slug
 * @returns Raw row data, or null when no row exists
 */
async function getRawUserComposioConnection(
  supabase: SupabaseClient,
  userId: string,
  toolkit: string
): Promise<UserComposioConnectionRow | null> {
  const { data, error } = await supabase
    .from("user_composio_connections")
    .select("toolkit, provider, connected_account_id, status, external_user_id, connected_at, last_error")
    .eq("user_id", userId)
    .eq("toolkit", toolkit)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as UserComposioConnectionRow | null) ?? null;
}
