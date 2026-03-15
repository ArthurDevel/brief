/**
 * Session lifecycle management for voice calls.
 *
 * Tracks active call sessions including transcripts and token usage.
 * Creates session rows in the database at call start and finalizes
 * them with duration, cost, and transcript data at call end.
 *
 * Responsibilities:
 * - startSession: create a session row and return an in-memory tracker
 * - addTranscriptEntry: append transcript lines during the call
 * - addTokenUsage: accumulate token counts from response.done events
 * - endSession: calculate duration + cost, write final data to DB
 * - loadUserContext: load user settings, memory, and credentials from DB + Vault
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapConfig, SmtpConfig } from "@dublin/email";
import type { ToolApprovalConfig } from "@dublin/tools";
import { retrieveSecret } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

/** OpenAI Realtime API per-token rate (input), USD. */
const RATE_INPUT_TOKEN_USD = 0.00001;

/** OpenAI Realtime API per-token rate (output), USD. */
const RATE_OUTPUT_TOKEN_USD = 0.00004;

/** Twilio per-minute rate for voice calls, USD. */
const RATE_TWILIO_PER_MINUTE_USD = 0.014;

// ============================================================================
// TYPES
// ============================================================================

/** A single entry in the call transcript. */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

/** In-memory tracker for an active voice call session. */
export interface ActiveSession {
  sessionId: string;
  userId: string;
  startedAt: Date;
  transcript: TranscriptEntry[];
  tokensIn: number;
  tokensOut: number;
}

/** Full user context loaded from DB + Vault, needed to set up the relay. */
export interface UserContext {
  userId: string;
  imapConfig: ImapConfig;
  smtpConfig: SmtpConfig;
  voicePreference: string;
  toolApprovalConfig: ToolApprovalConfig;
  memoryEntries: { key: string; value: string }[];
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Creates a new session row in the database and returns an in-memory tracker.
 * @param userId - The ID of the user starting the call
 * @param supabase - Supabase client for DB operations
 * @returns ActiveSession tracker for the call duration
 */
export async function startSession(userId: string, supabase: SupabaseClient): Promise<ActiveSession> {
  const startedAt = new Date();

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      user_id: userId,
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create session: ${error?.message ?? "no data"}`);
  }

  return {
    sessionId: data.id,
    userId,
    startedAt,
    transcript: [],
    tokensIn: 0,
    tokensOut: 0,
  };
}

/**
 * Appends a transcript entry to the in-memory session.
 * @param session - The active session to update
 * @param entry - The transcript entry to add
 */
export function addTranscriptEntry(session: ActiveSession, entry: TranscriptEntry): void {
  session.transcript.push(entry);
}

/**
 * Accumulates token usage from a response.done event.
 * @param session - The active session to update
 * @param tokensIn - Number of input tokens from this response
 * @param tokensOut - Number of output tokens from this response
 */
export function addTokenUsage(session: ActiveSession, tokensIn: number, tokensOut: number): void {
  session.tokensIn += tokensIn;
  session.tokensOut += tokensOut;
}

/**
 * Finalizes a session: calculates duration and cost, writes to DB.
 * @param session - The active session to finalize
 * @param supabase - Supabase client for DB operations
 */
export async function endSession(session: ActiveSession, supabase: SupabaseClient): Promise<void> {
  const endedAt = new Date();
  const durationSeconds = Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000);

  // Estimate cost from token usage + call duration
  const tokenCost = session.tokensIn * RATE_INPUT_TOKEN_USD + session.tokensOut * RATE_OUTPUT_TOKEN_USD;
  const twilioCost = (durationSeconds / 60) * RATE_TWILIO_PER_MINUTE_USD;
  const costUsd = Math.round((tokenCost + twilioCost) * 10000) / 10000; // Round to 4 decimals

  const { error } = await supabase
    .from("sessions")
    .update({
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      transcript: session.transcript,
      tokens_in: session.tokensIn,
      tokens_out: session.tokensOut,
      cost_usd: costUsd,
    })
    .eq("id", session.sessionId);

  if (error) {
    throw new Error(`Failed to end session ${session.sessionId}: ${error.message}`);
  }

  console.log(
    `[session] Ended ${session.sessionId}: ${durationSeconds}s, ` +
      `${session.tokensIn} tokens in, ${session.tokensOut} tokens out, $${costUsd}`
  );
}

/**
 * Loads full user context from DB and Vault (settings, memory, credentials).
 * @param userId - The user ID to load context for
 * @param supabase - Supabase client for DB + Vault operations
 * @returns UserContext with IMAP/SMTP configs, preferences, and memory
 */
export async function loadUserContext(userId: string, supabase: SupabaseClient): Promise<UserContext> {
  // Load user settings
  const { data: settings, error: settingsError } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (settingsError || !settings) {
    throw new Error(`User settings not found for ${userId}: ${settingsError?.message ?? "no data"}`);
  }

  // Retrieve IMAP and SMTP passwords from Vault
  if (!settings.imap_password_secret_id) {
    throw new Error(`IMAP credentials not configured for user ${userId}`);
  }
  if (!settings.smtp_password_secret_id) {
    throw new Error(`SMTP credentials not configured for user ${userId}`);
  }

  const [imapPassword, smtpPassword] = await Promise.all([
    retrieveSecret(supabase, settings.imap_password_secret_id),
    retrieveSecret(supabase, settings.smtp_password_secret_id),
  ]);

  // Load user memory entries
  const { data: memoryRows, error: memoryError } = await supabase
    .from("user_memory")
    .select("key, value")
    .eq("user_id", userId);

  if (memoryError) {
    throw new Error(`Failed to load memory for ${userId}: ${memoryError.message}`);
  }

  const imapConfig: ImapConfig = {
    host: settings.imap_host,
    port: settings.imap_port,
    user: settings.imap_user,
    password: imapPassword,
  };

  const smtpConfig: SmtpConfig = {
    host: settings.smtp_host,
    port: settings.smtp_port,
    user: settings.smtp_user,
    password: smtpPassword,
  };

  return {
    userId,
    imapConfig,
    smtpConfig,
    voicePreference: settings.voice_preference ?? "ash",
    toolApprovalConfig: (settings.tool_approval_config as ToolApprovalConfig) ?? {},
    memoryEntries: memoryRows ?? [],
  };
}
