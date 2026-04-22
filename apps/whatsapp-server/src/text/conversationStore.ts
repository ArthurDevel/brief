/**
 * Conversation orchestration for WhatsApp text turns.
 *
 * Responsibilities:
 * - Persist inbound WhatsApp text rows before LLM handling
 * - Load recent thread history plus user memory for the interaction agent
 * - Persist outbound WhatsApp replies after delivery
 */

import {
  createWhatsAppCoreStore,
  type WhatsAppCoreStore,
} from "@dublin/whatsapp-core";
import { getWhatsAppTextAgentEnv } from "./env.js";
import type {
  PrepareInboundTextTurnDto,
  PreparedInboundTextTurnResultDto,
  RecordOutboundTextReplyDto,
} from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_HISTORY_MESSAGES = 20;

// ============================================================================
// MAIN CLASS
// ============================================================================

export class WhatsAppTextConversationStore {
  private readonly coreStore: WhatsAppCoreStore;

  /**
   * Creates the WhatsApp text conversation store.
   * @param coreStore - Shared WhatsApp core storage service
   */
  constructor(coreStore: WhatsAppCoreStore) {
    this.coreStore = coreStore;
  }

  /**
   * Stores one inbound message and loads the prepared turn context.
   * @param input - Inbound webhook message DTO
   * @returns Prepared turn, or a duplicate marker
   */
  async prepareInboundTurn(
    input: PrepareInboundTextTurnDto
  ): Promise<PreparedInboundTextTurnResultDto> {
    console.info("[whatsapp-server] preparing inbound text turn", {
      fromPhone: input.fromPhone,
      messageId: input.messageId,
      textLength: input.text.length,
    });

    const storedInboundMessage = await this.coreStore.storeInboundTextMessage({
      fromPhone: input.fromPhone,
      metaMessageId: input.messageId,
      rawPayload: input.rawPayload,
      text: input.text,
    });

    if (storedInboundMessage.status === "duplicate" || !storedInboundMessage.message) {
      console.info("[whatsapp-server] inbound text turn is duplicate", {
        fromPhone: input.fromPhone,
        messageId: input.messageId,
        userId: storedInboundMessage.user.userId,
      });

      return {
        linkedUser: storedInboundMessage.user,
        status: "duplicate",
        turn: null,
      };
    }

    const [conversationHistory, memoryEntries] = await Promise.all([
      this.coreStore.listConversationMessages({
        contactPhoneNumber: storedInboundMessage.user.whatsappPhone,
        limit: MAX_HISTORY_MESSAGES,
        userId: storedInboundMessage.user.userId,
      }),
      this.coreStore.getUserMemoryEntries(storedInboundMessage.user.userId),
    ]);

    console.info("[whatsapp-server] prepared inbound text turn", {
      currentMessageId: storedInboundMessage.message.id,
      historyCount: conversationHistory.length,
      memoryCount: memoryEntries.length,
      userId: storedInboundMessage.user.userId,
      whatsappPhone: storedInboundMessage.user.whatsappPhone,
    });

    return {
      linkedUser: storedInboundMessage.user,
      status: "ready",
      turn: {
        conversationHistory: conversationHistory.filter(
          (message) => message.id !== storedInboundMessage.message?.id
        ),
        currentMessage: storedInboundMessage.message,
        linkedUser: storedInboundMessage.user,
        memoryEntries,
      },
    };
  }

  /**
   * Persists one outbound assistant reply after it is sent to WhatsApp.
   * @param input - Outbound reply DTO
   * @returns Promise that resolves when the row is stored
   */
  async recordOutboundReply(input: RecordOutboundTextReplyDto): Promise<void> {
    console.info("[whatsapp-server] recording outbound text reply", {
      replyLength: input.replyText.length,
      userId: input.linkedUser.userId,
      whatsappPhone: input.linkedUser.whatsappPhone,
    });

    await this.coreStore.storeOutboundTextMessage({
      rawPayload: input.rawPayload,
      text: input.replyText,
      toPhone: input.linkedUser.whatsappPhone,
      userId: input.linkedUser.userId,
    });

    console.info("[whatsapp-server] recorded outbound text reply", {
      replyLength: input.replyText.length,
      userId: input.linkedUser.userId,
      whatsappPhone: input.linkedUser.whatsappPhone,
    });
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp text conversation store from env.
 * @returns Ready-to-use conversation store
 */
export function createWhatsAppTextConversationStore(): WhatsAppTextConversationStore {
  const env = getWhatsAppTextAgentEnv();

  return new WhatsAppTextConversationStore(
    createWhatsAppCoreStore({
      supabaseServiceRoleKey: env.supabaseServiceRoleKey,
      supabaseUrl: env.supabaseUrl,
    })
  );
}
