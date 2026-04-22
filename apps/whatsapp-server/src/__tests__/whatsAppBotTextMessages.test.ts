import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppUserNotFoundError } from "@dublin/whatsapp-core";
import { WhatsAppBot } from "../whatsAppBot.js";
import type { PreparedInboundTextTurnResultDto } from "../text/types.js";

// ============================================================================
// TYPES
// ============================================================================

interface MockWhatsAppClient {
  messages: {
    text: ReturnType<typeof vi.fn>;
  };
  media: {
    getMediaById: ReturnType<typeof vi.fn>;
  };
  calling: {
    preAcceptCall: ReturnType<typeof vi.fn>;
    acceptCall: ReturnType<typeof vi.fn>;
    rejectCall: ReturnType<typeof vi.fn>;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a minimal WhatsApp client mock for text-message tests.
 * @returns Mock client with text, media, and calling methods
 */
function createMockClient(): MockWhatsAppClient {
  return {
    messages: {
      text: vi.fn().mockResolvedValue(undefined),
    },
    media: {
      getMediaById: vi.fn(),
    },
    calling: {
      preAcceptCall: vi.fn(),
      acceptCall: vi.fn(),
      rejectCall: vi.fn(),
    },
  };
}

/**
 * Creates a standard prepared-turn DTO for text interaction tests.
 * @param text - Current inbound user message text
 * @returns Prepared text turn result
 */
function createPreparedTurn(text: string): PreparedInboundTextTurnResultDto {
  return {
    linkedUser: {
      userId: "user-1",
      whatsappPhone: "+15551234567",
    },
    status: "ready",
    turn: {
      conversationHistory: [
        {
          id: "history-1",
          contactPhoneNumber: "+15551234567",
          createdAt: "2026-04-22T10:00:00.000Z",
          direction: "inbound",
          metaMessageId: "wamid.old",
          status: "received",
          text: "previous question",
          userId: "user-1",
        },
      ],
      currentMessage: {
        id: "current-1",
        contactPhoneNumber: "+15551234567",
        createdAt: "2026-04-22T10:01:00.000Z",
        direction: "inbound",
        metaMessageId: "wamid.text",
        status: "received",
        text,
        userId: "user-1",
      },
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      memoryEntries: [
        {
          id: "memory-1",
          content: "Prefers concise replies",
        },
      ],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-access-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123456789");
  vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "test-business-account");
  vi.stubEnv("WHATSAPP_WEB_BASE_URL", "https://app.example.com");
});

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppBot text messages", () => {
  it("keeps auth commands on the fast path", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn(),
      recordOutboundReply: vi.fn(),
    };
    const textInteractionAgent = {
      runTurn: vi.fn(),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.auth",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "authenticate overview",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(textConversationStore.prepareInboundTurn).not.toHaveBeenCalled();
    expect(textInteractionAgent.runTurn).not.toHaveBeenCalled();
    expect(client.messages.text).not.toHaveBeenCalled();
  });

  it("sends a text-agent reply and records the outbound message", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn().mockResolvedValue(createPreparedTurn("what did we talk about")),
      recordOutboundReply: vi.fn().mockResolvedValue(undefined),
    };
    const textInteractionAgent = {
      runTurn: vi.fn().mockImplementation(async (_turn, emitAction) => {
        await emitAction({
          message: "Short answer.",
          type: "message",
        });

        return {
          actions: [
            {
              message: "Short answer.",
              type: "message",
            },
          ],
          status: "completed",
        };
      }),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.text",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "what did we talk about",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(textConversationStore.prepareInboundTurn).toHaveBeenCalledWith({
      fromPhone: "15551234567",
      messageId: "wamid.text",
      rawPayload: {
        id: "wamid.text",
        from: "15551234567",
        type: "text",
        text: {
          body: "what did we talk about",
        },
      },
      text: "what did we talk about",
    });
    expect(textInteractionAgent.runTurn).toHaveBeenCalledWith(
      createPreparedTurn("what did we talk about").turn,
      expect.any(Function)
    );
    expect(client.messages.text).toHaveBeenCalledWith({
      body: "Short answer.",
      to: "15551234567",
      replyMessageId: "wamid.text",
    });
    expect(textConversationStore.recordOutboundReply).toHaveBeenCalledWith({
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      rawPayload: {
        action: {
          message: "Short answer.",
          type: "message",
        },
        inReplyToMessageId: "wamid.text",
        text: "Short answer.",
      },
      replyText: "Short answer.",
    });
  });

  it("does not reply twice when the inbound webhook is a duplicate", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn().mockResolvedValue({
        linkedUser: {
          userId: "user-1",
          whatsappPhone: "+15551234567",
        },
        status: "duplicate",
        turn: null,
      } satisfies PreparedInboundTextTurnResultDto),
      recordOutboundReply: vi.fn(),
    };
    const textInteractionAgent = {
      runTurn: vi.fn(),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.text",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "duplicate",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(textInteractionAgent.runTurn).not.toHaveBeenCalled();
    expect(client.messages.text).not.toHaveBeenCalled();
    expect(textConversationStore.recordOutboundReply).not.toHaveBeenCalled();
  });

  it("sends a WhatsApp auth template when the interaction agent emits an auth action", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn().mockResolvedValue(createPreparedTurn("connect outlook")),
      recordOutboundReply: vi.fn().mockResolvedValue(undefined),
    };
    const textInteractionAgent = {
      runTurn: vi.fn().mockImplementation(async (_turn, emitAction) => {
        await emitAction({
          toolkit: "outlook",
          type: "auth_template",
        });

        return {
          actions: [
            {
              toolkit: "outlook",
              type: "auth_template",
            },
          ],
          status: "completed",
        };
      }),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.auth-template",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "connect outlook",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(client.messages.text).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789/messages",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(textConversationStore.recordOutboundReply).toHaveBeenCalledWith({
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      rawPayload: {
        action: {
          toolkit: "outlook",
          type: "auth_template",
        },
        inReplyToMessageId: "wamid.auth-template",
        text: "Sent the WhatsApp Outlook connection template.",
      },
      replyText: "Sent the WhatsApp Outlook connection template.",
    });
  });

  it("does not send a WhatsApp message when the interaction agent chooses wait", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn().mockResolvedValue(createPreparedTurn("already handled")),
      recordOutboundReply: vi.fn(),
    };
    const textInteractionAgent = {
      runTurn: vi.fn().mockResolvedValue({
        actions: [],
        status: "wait",
      }),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.wait",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "already handled",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(client.messages.text).not.toHaveBeenCalled();
    expect(textConversationStore.recordOutboundReply).not.toHaveBeenCalled();
  });

  it("sends a connect-first message when the WhatsApp number is unknown", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textConversationStore = {
      prepareInboundTurn: vi.fn().mockRejectedValue(
        new WhatsAppUserNotFoundError("+15551234567")
      ),
      recordOutboundReply: vi.fn(),
    };
    const textInteractionAgent = {
      runTurn: vi.fn(),
    };
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textConversationStore as any,
      textInteractionAgent: textInteractionAgent as any,
      voiceMessageTranscriber: {
        transcribeVoiceMessage: vi.fn(),
      } as any,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.unknown",
                    from: "15551234567",
                    type: "text",
                    text: {
                      body: "hi",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(client.messages.text).toHaveBeenCalledWith({
      body: "I couldn't find an account for this WhatsApp number. Send authenticate overview to connect first.",
      to: "15551234567",
      replyMessageId: "wamid.unknown",
    });
  });
});
