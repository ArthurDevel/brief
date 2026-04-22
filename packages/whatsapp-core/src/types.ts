/**
 * Shared DTOs for WhatsApp server-side flows.
 *
 * Responsibilities:
 * - Define caller lookup data shared across WhatsApp runtimes
 * - Define conversation row shapes loaded from Supabase
 * - Define write DTOs for inbound and outbound WhatsApp messages
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
