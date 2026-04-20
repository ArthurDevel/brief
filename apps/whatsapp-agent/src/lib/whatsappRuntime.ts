/**
 * Runtime helpers for resolving the caller's user-scoped Gmail connection.
 *
 * Responsibilities:
 * - Parse LiveKit participant metadata from the WhatsApp bridge
 * - Resolve the matching Supabase user by whatsapp_phone
 * - Load the saved Gmail Composio connection for the caller
 */

import { createClient } from "@supabase/supabase-js";
import type { AgentEnv } from "./env.js";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppParticipantMetadata {
  caller: string | null;
}

interface CallerLookupRow {
  user_id: string;
}

interface ComposioConnectionLookupRow {
  connected_account_id: string | null;
  last_error: string | null;
  status: "connected" | "reconnect_required" | "pending" | "error";
}

export interface WhatsAppCallerContext {
  callerPhone: string;
  gmailConnectedAccountId: string;
  supabaseUserId: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Resolves the caller's Gmail connection from participant metadata.
 * @param env - Agent environment config
 * @param participantMetadata - LiveKit participant metadata JSON from the bridge
 * @returns Caller context used to create a user-scoped Composio session
 */
export async function resolveWhatsAppCallerContext(
  env: AgentEnv,
  participantMetadata: string
): Promise<WhatsAppCallerContext> {
  const metadata = parseWhatsAppParticipantMetadata(participantMetadata);
  if (!metadata.caller) {
    throw new Error("I could not identify the WhatsApp caller for this session.");
  }

  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: callerRow, error: callerError } = await supabase
    .from("user_settings")
    .select("user_id")
    .eq("whatsapp_phone", metadata.caller)
    .maybeSingle();

  if (callerError) {
    throw new Error(`Failed to look up the WhatsApp caller: ${callerError.message}`);
  }

  if (!(callerRow as CallerLookupRow | null)?.user_id) {
    throw new Error("I could not find an account for this WhatsApp number. Sign in from the WhatsApp link first.");
  }

  const userId = (callerRow as CallerLookupRow).user_id;
  const { data: connectionRow, error: connectionError } = await supabase
    .from("user_composio_connections")
    .select("connected_account_id, status, last_error")
    .eq("user_id", userId)
    .eq("toolkit", "gmail")
    .maybeSingle();

  if (connectionError) {
    throw new Error(`Failed to load the Gmail connection: ${connectionError.message}`);
  }

  const connection = connectionRow as ComposioConnectionLookupRow | null;
  if (!connection?.connected_account_id || connection.status !== "connected") {
    throw new Error(buildMissingConnectionMessage(connection));
  }

  return {
    callerPhone: metadata.caller,
    gmailConnectedAccountId: connection.connected_account_id,
    supabaseUserId: userId,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses participant metadata from the WhatsApp LiveKit bridge.
 * @param participantMetadata - Raw participant metadata string
 * @returns Parsed metadata containing the caller phone
 */
function parseWhatsAppParticipantMetadata(
  participantMetadata: string
): WhatsAppParticipantMetadata {
  if (!participantMetadata.trim()) {
    throw new Error("LiveKit participant metadata is missing.");
  }

  const parsed = JSON.parse(participantMetadata) as Partial<WhatsAppParticipantMetadata>;
  return {
    caller: typeof parsed.caller === "string" && parsed.caller.trim().length > 0
      ? parsed.caller.trim()
      : null,
  };
}

/**
 * Returns the spoken error message when no usable Gmail connection exists.
 * @param connection - Existing connection row, if any
 * @returns Spoken guidance for the caller
 */
function buildMissingConnectionMessage(
  connection: ComposioConnectionLookupRow | null
): string {
  if (connection?.status === "reconnect_required") {
    return "Your Gmail connection needs to be reconnected. Send authenticate gmail in WhatsApp and try again.";
  }

  if (connection?.status === "error" && connection.last_error) {
    return `${connection.last_error} Send authenticate gmail in WhatsApp and try again.`;
  }

  return "Your Gmail account is not connected yet. Send authenticate gmail in WhatsApp and try again.";
}
