/**
 * Persists WhatsApp agent sessions to the shared sessions table.
 *
 * Responsibilities:
 * - Create a session row when a WhatsApp call starts
 * - Serialize final transcript entries from the LiveKit session history
 * - Persist raw LiveKit model usage for external cost calculation
 */

import { createClient } from "@supabase/supabase-js";
import { voice } from "@livekit/agents";
import type { AgentEnv } from "./env.js";

// ============================================================================
// TYPES
// ============================================================================

interface ChatHistoryItem {
  content?: unknown;
  createdAt?: number;
  role?: string;
  type?: string;
}

interface ChatHistoryJson {
  items?: ChatHistoryItem[];
}

interface SessionTranscriptEntry {
  role: "assistant" | "user";
  text: string;
  timestamp: string;
}

interface StoredModelUsage {
  audioDurationMs?: number;
  charactersCount?: number;
  inputCachedTokens?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  provider?: string;
  sessionDurationMs?: number;
  type?: string;
}

interface SessionUsageTotals {
  tokensIn: number;
  tokensOut: number;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Creates a new session row for the WhatsApp agent.
 * @param env - Agent environment config
 * @param userId - Supabase user ID for the WhatsApp caller
 * @param startedAt - Timestamp when the agent session started
 * @returns Created session ID
 */
export async function createWhatsAppSession(
  env: AgentEnv,
  userId: string,
  startedAt: Date
): Promise<string> {
  const supabase = createServiceRoleClient(env);
  const { data, error } = await supabase
    .from("sessions")
    .insert({
      user_id: userId,
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create WhatsApp session: ${error.message}`);
  }

  if (!data?.id || typeof data.id !== "string") {
    throw new Error("Failed to create WhatsApp session: missing session ID.");
  }

  return data.id;
}

/**
 * Finalizes a WhatsApp session with transcript, usage, and duration.
 * @param env - Agent environment config
 * @param sessionId - Existing sessions.id value
 * @param session - LiveKit voice agent session
 * @param startedAt - Timestamp when the agent session started
 * @param endedAt - Timestamp when the agent session ended
 * @returns Promise that resolves when the session row is updated
 */
export async function finalizeWhatsAppSession(
  env: AgentEnv,
  sessionId: string,
  session: voice.AgentSession,
  startedAt: Date,
  endedAt: Date
): Promise<void> {
  const transcript = buildTranscript(session);
  const modelUsage = buildModelUsage(session);
  const usageTotals = buildUsageTotals(modelUsage);
  const durationSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  );

  const supabase = createServiceRoleClient(env);
  const { error } = await supabase
    .from("sessions")
    .update({
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      transcript,
      tokens_in: usageTotals.tokensIn,
      tokens_out: usageTotals.tokensOut,
      model_usage: modelUsage,
    })
    .eq("id", sessionId);

  if (error) {
    throw new Error(`Failed to finalize WhatsApp session: ${error.message}`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a Supabase service-role client for agent-side writes.
 * @param env - Agent environment config
 * @returns Configured Supabase client
 */
function createServiceRoleClient(env: AgentEnv) {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Builds transcript entries from the committed LiveKit chat history.
 * @param session - LiveKit voice agent session
 * @returns Transcript entries for the sessions table
 */
function buildTranscript(session: voice.AgentSession): SessionTranscriptEntry[] {
  const historyJson = session.history.toJSON({
    excludeAudio: true,
    excludeFunctionCall: true,
    excludeImage: true,
    excludeTimestamp: false,
  }) as ChatHistoryJson;

  if (!Array.isArray(historyJson.items)) {
    return [];
  }

  return historyJson.items.flatMap((item) => {
    if (item.type !== "message") {
      return [];
    }

    if (item.role !== "user" && item.role !== "assistant") {
      return [];
    }

    const text = extractTextContent(item.content);
    if (!text) {
      return [];
    }

    const createdAt = typeof item.createdAt === "number"
      ? new Date(item.createdAt).toISOString()
      : new Date().toISOString();

    return [{
      role: item.role,
      text,
      timestamp: createdAt,
    }];
  });
}

/**
 * Extracts joined text content from a serialized ChatMessage content array.
 * @param content - Unknown serialized content value
 * @returns Joined text content or null when no text is available
 */
function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
  );
  if (textParts.length === 0) {
    return null;
  }

  return textParts.join("\n");
}

/**
 * Normalizes LiveKit usage objects into plain JSON-safe records.
 * @param session - LiveKit voice agent session
 * @returns Raw model usage records for storage
 */
function buildModelUsage(session: voice.AgentSession): StoredModelUsage[] {
  return session.usage.modelUsage.map((usage) => {
    const usageRecord = usage as Record<string, unknown>;

    return {
      audioDurationMs: toNumberOrUndefined(usageRecord.audioDurationMs),
      charactersCount: toNumberOrUndefined(usageRecord.charactersCount),
      inputCachedTokens: toNumberOrUndefined(usageRecord.inputCachedTokens),
      inputTokens: toNumberOrUndefined(usageRecord.inputTokens),
      model: typeof usageRecord.model === "string" ? usageRecord.model : undefined,
      outputTokens: toNumberOrUndefined(usageRecord.outputTokens),
      provider: typeof usageRecord.provider === "string" ? usageRecord.provider : undefined,
      sessionDurationMs: toNumberOrUndefined(usageRecord.sessionDurationMs),
      type: typeof usageRecord.type === "string" ? usageRecord.type : undefined,
    };
  });
}

/**
 * Aggregates LLM token totals from raw model usage.
 * @param modelUsage - Stored model usage records
 * @returns Token totals for the legacy session columns
 */
function buildUsageTotals(modelUsage: StoredModelUsage[]): SessionUsageTotals {
  let tokensIn = 0;
  let tokensOut = 0;

  for (const usage of modelUsage) {
    if (usage.type !== "llm_usage") {
      continue;
    }

    tokensIn += usage.inputTokens ?? 0;
    tokensOut += usage.outputTokens ?? 0;
  }

  return {
    tokensIn,
    tokensOut,
  };
}

/**
 * Returns a number only when the input is a finite number.
 * @param value - Unknown value from the LiveKit usage object
 * @returns Finite number or undefined
 */
function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
