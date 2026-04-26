/**
 * Runtime helpers for resolving the caller's user-scoped Composio connections.
 *
 * Responsibilities:
 * - Parse LiveKit participant metadata from the WhatsApp bridge
 * - Resolve or create the matching Supabase user by whatsapp_phone
 * - Load the live Composio connections for the caller
 */

import { Composio } from "@composio/core";
import { createWhatsAppCoreStore } from "@dublin/whatsapp-core";
import { createClient } from "@supabase/supabase-js";
import type { AgentEnv } from "./env.js";
import {
  parseStoredWhatsAppVoiceConfig,
  type WhatsAppVoiceConfig,
} from "./whatsappVoice.js";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppParticipantMetadata {
  caller: string | null;
}

interface CallerLookupRow {
  user_id: string;
  whatsapp_voice_config: unknown | null;
}

interface ComposioConnectedAccountRow {
  id: string;
  status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE";
  statusReason: string | null;
  toolkit: {
    slug: string;
  };
  updatedAt: string;
}

export interface WhatsAppCallerContext {
  callerPhone: string;
  connectionGuidanceMessage: string | null;
  connectedAccountsByToolkit: Record<string, string>;
  supabaseUserId: string;
  voiceConfig: WhatsAppVoiceConfig;
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
  const coreStore = createWhatsAppCoreStore({
    supabaseServiceRoleKey: env.supabaseServiceRoleKey,
    supabaseUrl: env.supabaseUrl,
  });

  const linkedUser = await coreStore.resolveOrCreateLinkedUserByPhone(metadata.caller);

  const callerLookupStartedAt = Date.now();
  const { data: callerRow, error: callerError } = await supabase
    .from("user_settings")
    .select("user_id, whatsapp_voice_config")
    .eq("user_id", linkedUser.userId)
    .maybeSingle();
  console.info("[whatsapp-agent] user_settings lookup complete", {
    callerPhone: linkedUser.whatsappPhone,
    foundUser: Boolean((callerRow as CallerLookupRow | null)?.user_id),
    elapsedMs: Date.now() - callerLookupStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  if (callerError) {
    throw new Error(`Failed to look up the WhatsApp caller: ${callerError.message}`);
  }

  if (!(callerRow as CallerLookupRow | null)?.user_id) {
    throw new Error("Failed to load the WhatsApp caller settings.");
  }

  const userId = (callerRow as CallerLookupRow).user_id;
  const voiceConfig = parseStoredWhatsAppVoiceConfig(
    (callerRow as CallerLookupRow).whatsapp_voice_config
  );
  const composio = createComposioClient(env);
  const connectionsLookupStartedAt = Date.now();
  const connectionResponse = await composio.connectedAccounts.list({
    userIds: [userId],
    limit: 100,
  });
  console.info("[whatsapp-agent] composio connectedAccounts lookup complete", {
    userId,
    rowCount: Array.isArray(connectionResponse.items) ? connectionResponse.items.length : 0,
    elapsedMs: Date.now() - connectionsLookupStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  const connections = Array.isArray(connectionResponse.items)
    ? (connectionResponse.items as ComposioConnectedAccountRow[])
    : [];
  const connectedAccountsByToolkit = buildConnectedAccountsByToolkit(connections);
  console.info("[whatsapp-agent] connected toolkit summary", {
    userId,
    connections: connections.map((connection) => ({
      toolkit: connection.toolkit.slug,
      status: connection.status,
      hasConnectedAccountId: Boolean(connection.id),
    })),
    connectedToolkitSlugs: Object.keys(connectedAccountsByToolkit),
    totalElapsedMs: Date.now() - startedAt,
  });

  return {
    callerPhone: linkedUser.whatsappPhone,
    connectionGuidanceMessage: buildConnectionGuidanceMessage(connections),
    connectedAccountsByToolkit,
    supabaseUserId: userId,
    voiceConfig,
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
  connections: ComposioConnectedAccountRow[]
): Record<string, string> {
  const connectedAccountsByToolkit: Record<string, string> = {};
  const latestUpdatedAtByToolkit = new Map<string, number>();

  for (const connection of connections) {
    const toolkit = connection.toolkit.slug.trim().toLowerCase();
    if (!toolkit || connection.status !== "ACTIVE") {
      continue;
    }

    const updatedAt = new Date(connection.updatedAt).getTime();
    const latestUpdatedAt = latestUpdatedAtByToolkit.get(toolkit) ?? Number.NEGATIVE_INFINITY;

    if (updatedAt >= latestUpdatedAt) {
      connectedAccountsByToolkit[toolkit] = connection.id;
      latestUpdatedAtByToolkit.set(toolkit, updatedAt);
    }
  }

  return connectedAccountsByToolkit;
}

/**
 * Returns the spoken guidance when the caller still needs to connect or reconnect apps.
 * @param connections - Existing connection rows, if any
 * @returns Spoken guidance for the caller, or null when no extra guidance is needed
 */
function buildConnectionGuidanceMessage(
  connections: ComposioConnectedAccountRow[]
): string | null {
  if (connections.some((connection) => connection.status === "ACTIVE")) {
    return null;
  }

  if (connections.some((connection) => connection.status === "EXPIRED" || connection.status === "INACTIVE")) {
    return "One of your connected apps needs to be reconnected. Send authenticate overview in WhatsApp and try again.";
  }

  const failedConnection = connections.find(
    (connection) => connection.status === "FAILED" && connection.statusReason
  );
  if (failedConnection?.statusReason) {
    return `${failedConnection.statusReason} Send authenticate overview in WhatsApp and try again.`;
  }

  return "You do not have any connected apps yet. Send authenticate overview in WhatsApp and connect one first.";
}

/**
 * Creates a Composio SDK client for agent-side reads.
 * @param env - Agent environment config
 * @returns Configured Composio SDK client
 */
function createComposioClient(env: AgentEnv): Composio {
  return new Composio({
    apiKey: env.composioApiKey,
  });
}
