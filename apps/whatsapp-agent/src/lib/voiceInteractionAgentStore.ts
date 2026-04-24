/**
 * Supabase-backed storage for WhatsApp voice interaction-agent history.
 *
 * Responsibilities:
 * - Persist interaction-agent messages for one voice call session
 * - Persist interaction-agent tool calls and tool results
 * - Load recent interaction-agent messages for prompt history
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentEnv } from "./env.js";
import type { VoiceConversationMessageDto } from "./openpoke/types.js";

// ============================================================================
// TYPES
// ============================================================================

interface VoiceInteractionAgentMessageRow {
  created_at: string;
  id: string;
  role: "assistant" | "tool" | "user";
  session_id: string;
  text: string;
  tool_arguments: Record<string, unknown> | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_result: Record<string, unknown> | null;
  type: "message" | "tool_call" | "tool_result";
  user_id: string;
}

export interface AppendVoiceInteractionAgentMessageDto {
  role: "assistant" | "user";
  text: string;
}

export interface AppendVoiceInteractionAgentToolCallDto {
  toolArguments: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
}

export interface AppendVoiceInteractionAgentToolResultDto {
  toolCallId: string;
  toolName: string;
  toolResult: Record<string, unknown>;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceInteractionAgentStore {
  private readonly sessionId: string;
  private readonly supabase: SupabaseClient;
  private readonly userId: string;

  /**
   * Creates the voice interaction-agent storage service for one call session.
   * @param supabase - Service-role Supabase client
   * @param sessionId - Current voice session ID
   * @param userId - Supabase user ID that owns the session
   */
  constructor(
    supabase: SupabaseClient,
    sessionId: string,
    userId: string
  ) {
    this.supabase = supabase;
    this.sessionId = sessionId;
    this.userId = userId;
  }

  /**
   * Loads recent persisted interaction-agent messages for this voice session.
   * Only user and assistant message rows are returned for prompt history.
   * @param limit - Maximum message count to load
   * @returns Stored interaction-agent conversation messages
   */
  async listVoiceInteractionAgentMessages(
    limit: number
  ): Promise<VoiceConversationMessageDto[]> {
    const { data, error } = await this.supabase
      .from("whatsapp_voiceagent_messages")
      .select("id, session_id, user_id, type, role, text, tool_name, tool_call_id, tool_arguments, tool_result, created_at")
      .eq("session_id", this.sessionId)
      .eq("user_id", this.userId)
      .eq("type", "message")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to load voice interaction-agent messages: ${error.message}`);
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((row) => this.mapVoiceInteractionAgentMessageRow(
        row as VoiceInteractionAgentMessageRow
      ))
      .reverse();
  }

  /**
   * Persists one user or assistant interaction-agent message.
   * @param input - Voice interaction-agent message append DTO
   * @returns Stored conversation message DTO for in-memory history
   */
  async appendVoiceInteractionAgentMessage(
    input: AppendVoiceInteractionAgentMessageDto
  ): Promise<VoiceConversationMessageDto> {
    const { data, error } = await this.supabase
      .from("whatsapp_voiceagent_messages")
      .insert({
        role: input.role,
        session_id: this.sessionId,
        text: input.text,
        type: "message",
        user_id: this.userId,
      })
      .select("id, session_id, user_id, type, role, text, tool_name, tool_call_id, tool_arguments, tool_result, created_at")
      .single();

    if (error) {
      throw new Error(`Failed to store voice interaction-agent message: ${error.message}`);
    }

    return this.mapVoiceInteractionAgentMessageRow(data as VoiceInteractionAgentMessageRow);
  }

  /**
   * Persists one interaction-agent tool call for this voice session.
   * @param input - Voice interaction-agent tool-call append DTO
   * @returns Nothing
   */
  async appendVoiceInteractionAgentToolCall(
    input: AppendVoiceInteractionAgentToolCallDto
  ): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_voiceagent_messages")
      .insert({
        role: "assistant",
        session_id: this.sessionId,
        tool_arguments: input.toolArguments,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        type: "tool_call",
        user_id: this.userId,
      });

    if (error) {
      throw new Error(`Failed to store voice interaction-agent tool call: ${error.message}`);
    }
  }

  /**
   * Persists one interaction-agent tool result for this voice session.
   * @param input - Voice interaction-agent tool-result append DTO
   * @returns Nothing
   */
  async appendVoiceInteractionAgentToolResult(
    input: AppendVoiceInteractionAgentToolResultDto
  ): Promise<void> {
    const { error } = await this.supabase
      .from("whatsapp_voiceagent_messages")
      .insert({
        role: "tool",
        session_id: this.sessionId,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        tool_result: input.toolResult,
        type: "tool_result",
        user_id: this.userId,
      });

    if (error) {
      throw new Error(`Failed to store voice interaction-agent tool result: ${error.message}`);
    }
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Maps one stored interaction-agent message row into prompt-history format.
   * @param row - Raw Supabase message row
   * @returns Voice conversation message DTO
   */
  private mapVoiceInteractionAgentMessageRow(
    row: VoiceInteractionAgentMessageRow
  ): VoiceConversationMessageDto {
    return {
      createdAt: row.created_at,
      direction: row.role === "user" ? "inbound" : "outbound",
      text: row.text,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default voice interaction-agent store from env.
 * @param env - Agent environment config
 * @param sessionId - Current voice session ID
 * @param userId - Supabase user ID that owns the session
 * @returns Ready-to-use voice interaction-agent store
 */
export function createVoiceInteractionAgentStore(
  env: AgentEnv,
  sessionId: string,
  userId: string
): VoiceInteractionAgentStore {
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return new VoiceInteractionAgentStore(supabase, sessionId, userId);
}
