/**
 * Runtime helpers for resolving the caller's user-scoped Composio connections.
 *
 * Responsibilities:
 * - Parse LiveKit participant metadata from the WhatsApp bridge
 * - Resolve the matching Supabase user by whatsapp_phone
 * - Load the saved Composio connections for the caller
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
  toolkit: string;
  connected_account_id: string | null;
  last_error: string | null;
  status: "connected" | "reconnect_required" | "pending" | "error";
}

export interface WhatsAppCallerContext {
  callerPhone: string;
  connectedAccountsByToolkit: Record<string, string>;
  supabaseUserId: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Resolves the caller's connected Composio accounts from participant metadata.
 * @param env - Agent environment config
 * @param participantMetadata - LiveKit participant metadata JSON from the bridge
 * @returns Caller context used to create a user-scoped Composio session
 */
export async function resolveWhatsAppCallerContext(
  env: AgentEnv,
  participantMetadata: string
): Promise<WhatsAppCallerContext> {
  const startedAt = Date.now();
  console.info("[whatsapp-agent] resolveWhatsAppCallerContext start", {
    participantMetadataLength: participantMetadata.length,
  });

  const metadata = parseWhatsAppParticipantMetadata(participantMetadata);
  if (!metadata.caller) {
    throw new Error("I could not identify the WhatsApp caller for this session.");
  }
  console.info("[whatsapp-agent] participant metadata parsed", {
    callerPhone: metadata.caller,
    elapsedMs: Date.now() - startedAt,
  });

  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const callerLookupStartedAt = Date.now();
  const { data: callerRow, error: callerError } = await supabase
    .from("user_settings")
    .select("user_id")
    .eq("whatsapp_phone", metadata.caller)
    .maybeSingle();
  console.info("[whatsapp-agent] user_settings lookup complete", {
    callerPhone: metadata.caller,
    foundUser: Boolean((callerRow as CallerLookupRow | null)?.user_id),
    elapsedMs: Date.now() - callerLookupStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  if (callerError) {
    throw new Error(`Failed to look up the WhatsApp caller: ${callerError.message}`);
  }

  if (!(callerRow as CallerLookupRow | null)?.user_id) {
    throw new Error("I could not find an account for this WhatsApp number. Sign in from the WhatsApp link first.");
  }

  const userId = (callerRow as CallerLookupRow).user_id;
  const connectionsLookupStartedAt = Date.now();
  const { data: connectionRows, error: connectionError } = await supabase
    .from("user_composio_connections")
    .select("toolkit, connected_account_id, status, last_error")
    .eq("user_id", userId)
    .order("toolkit", { ascending: true });
  console.info("[whatsapp-agent] user_composio_connections lookup complete", {
    userId,
    rowCount: Array.isArray(connectionRows) ? connectionRows.length : 0,
    elapsedMs: Date.now() - connectionsLookupStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  if (connectionError) {
    throw new Error(`Failed to load the connected apps: ${connectionError.message}`);
  }

  const connections = Array.isArray(connectionRows)
    ? (connectionRows as ComposioConnectionLookupRow[])
    : [];
  const connectedAccountsByToolkit = buildConnectedAccountsByToolkit(connections);
  console.info("[whatsapp-agent] connected toolkit summary", {
    userId,
    connections: connections.map((connection) => ({
      toolkit: connection.toolkit,
      status: connection.status,
      hasConnectedAccountId: Boolean(connection.connected_account_id),
    })),
    connectedToolkitSlugs: Object.keys(connectedAccountsByToolkit),
    totalElapsedMs: Date.now() - startedAt,
  });

  if (Object.keys(connectedAccountsByToolkit).length === 0) {
    throw new Error(buildMissingConnectionsMessage(connections));
  }

  return {
    callerPhone: metadata.caller,
    connectedAccountsByToolkit,
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
 * Builds the connected account map for the Composio session.
 * @param connections - Saved connection rows for the caller
 * @returns Connected account IDs keyed by toolkit slug
 */
function buildConnectedAccountsByToolkit(
  connections: ComposioConnectionLookupRow[]
): Record<string, string> {
  const connectedAccountsByToolkit: Record<string, string> = {};

  for (const connection of connections) {
    const toolkit = connection.toolkit.trim().toLowerCase();
    if (!toolkit || !connection.connected_account_id || connection.status !== "connected") {
      continue;
    }

    connectedAccountsByToolkit[toolkit] = connection.connected_account_id;
  }

  return connectedAccountsByToolkit;
}

/**
 * Returns the spoken error message when no usable Composio connection exists.
 * @param connections - Existing connection rows, if any
 * @returns Spoken guidance for the caller
 */
function buildMissingConnectionsMessage(
  connections: ComposioConnectionLookupRow[]
): string {
  if (connections.some((connection) => connection.status === "reconnect_required")) {
    return "One of your connected apps needs to be reconnected. Send authenticate overview in WhatsApp and try again.";
  }

  const failedConnection = connections.find(
    (connection) => connection.status === "error" && connection.last_error
  );
  if (failedConnection?.last_error) {
    return `${failedConnection.last_error} Send authenticate overview in WhatsApp and try again.`;
  }

  return "You do not have any connected apps yet. Send authenticate overview in WhatsApp and connect one first.";
}
