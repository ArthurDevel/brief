/**
 * Shared DTOs for the WhatsApp emulator backend.
 *
 * Responsibilities:
 * - Define request and response payloads for the emulator API
 * - Keep the browser UI and server on a stable contract
 */

// ============================================================================
// API DTOS
// ============================================================================

export interface StartCallRequestDto {
  callerPhone: string;
}

export interface StartCallResponseDto {
  callId: string;
  participantIdentity: string;
  roomName: string;
  token: string;
  url: string;
}

export interface EndCallRequestDto {
  roomName: string;
}

export interface ApiErrorResponseDto {
  code: string;
  error: string;
}

export interface SendEmulatorTextMessageRequestDto {
  body: string;
  from: string;
}

export interface StoreOutboundTextMessageRequestDto {
  body: string;
  replyMessageId?: string;
  to: string;
}

export interface StoreTypingIndicatorRequestDto {
  messageId: string;
  to: string;
}

export interface EmulatorChatMessageDto {
  body: string;
  createdAt: string;
  direction: "inbound" | "outbound";
  id: string;
}

export interface ListEmulatorMessagesResponseDto {
  isTyping: boolean;
  messages: EmulatorChatMessageDto[];
}

// ============================================================================
// DOMAIN DTOS
// ============================================================================

export interface KnownCallerDto {
  phone: string;
  userId: string;
}

export interface EmulatorCallSessionDto {
  callId: string;
  participantIdentity: string;
  roomName: string;
  token: string;
  url: string;
}
