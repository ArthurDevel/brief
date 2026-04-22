/**
 * DTOs for the WhatsApp text interaction flow.
 *
 * Responsibilities:
 * - Define prepared turn data for the interaction agent
 * - Define interaction and execution runtime results
 * - Define reply results returned to the webhook bot
 */

import type {
  WhatsAppConversationMessageDto,
  WhatsAppLinkedUserDto,
  WhatsAppMemoryEntryDto,
} from "@dublin/whatsapp-core";

// ============================================================================
// SHARED DTOs
// ============================================================================

export interface PrepareInboundTextTurnDto {
  fromPhone: string;
  messageId: string;
  rawPayload: unknown;
  text: string;
}

export interface PreparedTextTurnDto {
  conversationHistory: WhatsAppConversationMessageDto[];
  currentMessage: WhatsAppConversationMessageDto;
  linkedUser: WhatsAppLinkedUserDto;
  memoryEntries: WhatsAppMemoryEntryDto[];
}

export interface DuplicateInboundTextTurnDto {
  linkedUser: WhatsAppLinkedUserDto;
  status: "duplicate";
}

export interface PreparedInboundTextTurnResultDto {
  linkedUser: WhatsAppLinkedUserDto;
  status: "duplicate" | "ready";
  turn: PreparedTextTurnDto | null;
}

export interface RecordOutboundTextReplyDto {
  linkedUser: WhatsAppLinkedUserDto;
  rawPayload: unknown;
  replyText: string;
}

export interface WhatsAppSendMessageActionDto {
  message: string;
  type: "message";
}

export interface WhatsAppSendDraftActionDto {
  body: string;
  subject: string;
  to: string;
  type: "draft";
}

export type WhatsAppUserVisibleActionDto =
  | WhatsAppSendDraftActionDto
  | WhatsAppSendMessageActionDto;

export interface RunInteractionTurnResultDto {
  actions: WhatsAppUserVisibleActionDto[];
  status: "completed" | "wait";
}

export interface ExecuteAgentRequestDto {
  agentName: string;
  instructions: string;
  linkedUser: WhatsAppLinkedUserDto;
}

export interface ExecuteAgentResultDto {
  agentName: string;
  response: string;
  success: boolean;
}
