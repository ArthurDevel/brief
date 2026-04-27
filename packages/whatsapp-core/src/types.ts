/**
 * Shared DTOs for WhatsApp server-side flows.
 *
 * Responsibilities:
 * - Define caller lookup data shared across WhatsApp runtimes
 * - Define conversation row shapes loaded from Supabase
 * - Define write DTOs for inbound and outbound WhatsApp messages
 * - Define persisted execution-agent thread and message DTOs
 */

// ============================================================================
// SHARED DTOs
// ============================================================================

export type WhatsAppMessageDirection = "inbound" | "outbound";

export interface WhatsAppLinkedUserDto {
  userId: string;
  whatsappPhone: string;
}

export interface WhatsAppMemoryEntryDto {
  id: string;
  content: string;
}

export interface WhatsAppConversationMessageDto {
  id: string;
  contactPhoneNumber: string;
  createdAt: string;
  direction: WhatsAppMessageDirection;
  metaMessageId: string | null;
  status: string;
  text: string;
  userId: string | null;
}

export interface ListWhatsAppConversationMessagesDto {
  contactPhoneNumber: string;
  limit: number;
  userId: string;
}

export interface StoreInboundWhatsAppTextMessageDto {
  fromPhone: string;
  metaMessageId: string;
  rawPayload: unknown;
  text: string;
}

export interface StoreInboundWhatsAppTextMessageResultDto {
  message: WhatsAppConversationMessageDto | null;
  status: "duplicate" | "inserted";
  user: WhatsAppLinkedUserDto;
}

export interface StoreOutboundWhatsAppTextMessageDto {
  rawPayload: unknown;
  text: string;
  toPhone: string;
  userId: string;
}

export interface ExecutionAgentThreadDto {
  agentName: string;
  createdAt: string;
  id: string;
  updatedAt: string;
  userId: string;
}

export type ExecutionAgentMessageRole = "assistant" | "tool" | "user";

export interface ExecutionAgentToolCallDto {
  arguments: Record<string, unknown>;
  id: string | null;
  name: string;
}

export interface ExecutionAgentMessageDto {
  content: string;
  createdAt: string;
  id: string;
  role: ExecutionAgentMessageRole;
  threadId: string;
  toolArguments: Record<string, unknown> | null;
  toolCallId: string | null;
  toolCalls: ExecutionAgentToolCallDto[] | null;
  toolName: string | null;
  toolResult: Record<string, unknown> | null;
  userId: string;
}

export interface FindOrCreateExecutionAgentThreadDto {
  agentName: string;
  userId: string;
}

export interface ListExecutionAgentThreadsDto {
  limit: number;
  userId: string;
}

export interface ListExecutionAgentMessagesDto {
  limit: number;
  threadId: string;
  userId: string;
}

export interface StoreExecutionAgentMessageDto {
  content: string;
  role: ExecutionAgentMessageRole;
  toolArguments: Record<string, unknown> | null;
  toolCallId: string | null;
  toolCalls: ExecutionAgentToolCallDto[] | null;
  toolName: string | null;
  toolResult: Record<string, unknown> | null;
}

export interface StoreExecutionAgentMessagesDto {
  messages: StoreExecutionAgentMessageDto[];
  threadId: string;
  userId: string;
}

export interface AppendExecutionAgentMessageDto {
  content: string;
  role: "assistant" | "user";
  threadId: string;
  userId: string;
}

export interface AppendExecutionAgentToolCallDto {
  content: string;
  threadId: string;
  toolCalls: ExecutionAgentToolCallDto[];
  userId: string;
}

export interface AppendExecutionAgentToolResultDto {
  content: string;
  threadId: string;
  toolArguments: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  toolResult: Record<string, unknown>;
  userId: string;
}

export interface TouchExecutionAgentThreadDto {
  threadId: string;
  userId: string;
}
