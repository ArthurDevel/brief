/**
 * Voice OpenPoke DTOs shared by the voice interaction and execution agents.
 *
 * Responsibilities:
 * - Define prepared turn data for the voice interaction agent
 * - Define interaction and execution runtime results
 * - Keep the voice OpenPoke runtime explicit and easy to follow
 */

import type { MemoryEntry } from "../memory.js";
import type { WhatsAppCallerContext } from "../whatsappRuntime.js";

// ============================================================================
// TYPES
// ============================================================================

export interface VoiceConversationMessageDto {
  createdAt: string;
  direction: "inbound" | "outbound";
  text: string;
}

export interface PreparedVoiceTurnDto {
  callerContext: WhatsAppCallerContext;
  conversationHistory: VoiceConversationMessageDto[];
  currentMessage: VoiceConversationMessageDto;
  memoryEntries: MemoryEntry[];
}

export type SupportedConnectorToolkit =
  | "gmail"
  | "googlecalendar"
  | "notion"
  | "outlook";

export interface VoiceSendMessageActionDto {
  message: string;
  type: "message";
}

export interface VoiceSendAuthTemplateActionDto {
  toolkit: SupportedConnectorToolkit;
  type: "auth_template";
}

export interface VoiceSendConnectorOverviewActionDto {
  type: "connector_overview";
}

export type VoiceUserVisibleActionDto =
  | VoiceSendAuthTemplateActionDto
  | VoiceSendConnectorOverviewActionDto
  | VoiceSendMessageActionDto;

export interface RunVoiceInteractionTurnResultDto {
  actions: VoiceUserVisibleActionDto[];
  status: "completed" | "wait";
}

export interface ExecuteVoiceAgentRequestDto {
  agentName: string;
  callerContext: WhatsAppCallerContext;
  instructions: string;
}

export interface ExecuteVoiceAgentResultDto {
  agentName: string;
  response: string;
  success: boolean;
}
