import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppBot, type WhatsAppWebhookBody } from "../whatsAppBot.js";
import type {
  VoiceMessageTranscriber,
  VoiceMessageTranscriptionRequest,
  VoiceMessageTranscriptionResult,
} from "../deepgramVoiceMessageTranscriber.js";
import type {
  PreparedInboundTextTurnResultDto,
  PreparedTextTurnDto,
  WhatsAppUserVisibleActionDto,
} from "../text/types.js";

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

interface DeferredPromise {
  promise: Promise<void>;
  resolve: () => void;
}

interface MockTextAgentDependencies {
  textConversationStore: {
    prepareInboundTurn: ReturnType<typeof vi.fn>;
    recordOutboundReply: ReturnType<typeof vi.fn>;
  };
  textInteractionAgent: {
    runTurn: ReturnType<typeof vi.fn>;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a minimal WhatsApp client mock for inbound message tests.
 * @returns Mock client with message, media, and calling methods
 */
function createMockClient(): MockWhatsAppClient {
  return {
    messages: {
      text: vi.fn().mockResolvedValue(undefined),
    },
    media: {
      getMediaById: vi.fn().mockResolvedValue({
        url: "https://graph.facebook.com/test-audio",
        mime_type: "audio/ogg",
      }),
    },
    calling: {
      preAcceptCall: vi.fn(),
      acceptCall: vi.fn(),
      rejectCall: vi.fn(),
    },
  };
}

/**
 * Creates an inbound audio webhook payload.
 * @returns Webhook body with one audio message
 */
function createAudioWebhookBody(): WhatsAppWebhookBody {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  id: "wamid.voice",
                  from: "15551234567",
                  type: "audio",
                  audio: {
                    id: "media-123",
                    mime_type: "audio/ogg",
                    url: "https://lookaside.fbsbx.com/test-audio",
                    voice: true,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Creates a deferred promise for coordinating async test flow.
 * @returns Promise with an external resolve function
 */
function createDeferredPromise(): DeferredPromise {
  let resolvePromise!: () => void;

  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: resolvePromise,
  };
}

/**
 * Creates mocked text-agent dependencies so unrelated tests do not boot the real text path.
 * @returns Mock text conversation store and interaction agent
 */
function createTextAgentDependencies(): MockTextAgentDependencies {
  const defaultPreparedTurn: PreparedInboundTextTurnResultDto = {
    linkedUser: {
      userId: "user-1",
      whatsappPhone: "+15551234567",
    },
    status: "ready",
    turn: {
      conversationHistory: [],
      currentMessage: {
        id: "msg-1",
        contactPhoneNumber: "+15551234567",
        createdAt: "2026-04-22T10:00:00.000Z",
        direction: "inbound",
        metaMessageId: "wamid.voice",
        status: "received",
        text: "hello world",
        userId: "user-1",
      },
      executionAgentThreads: [],
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      memoryEntries: [],
    },
  };

  return {
    textConversationStore: {
      prepareInboundTurn: vi.fn().mockResolvedValue(defaultPreparedTurn),
      recordOutboundReply: vi.fn().mockResolvedValue(undefined),
    },
    textInteractionAgent: {
      runTurn: vi.fn().mockImplementation(async (
        _turn: PreparedTextTurnDto,
        emitAction?: (action: WhatsAppUserVisibleActionDto) => Promise<void>
      ) => {
        const action = {
          message: "mocked text reply",
          type: "message",
        } satisfies WhatsAppUserVisibleActionDto;

        if (emitAction) {
          await emitAction(action);
        }

        return {
          actions: [action],
          status: "completed",
        };
      }),
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
});

/**
 * Creates a transcriber mock that returns a fixed transcript.
 * @param transcript - Transcript returned from the mock
 * @returns Voice message transcriber mock
 */
function createTranscriber(transcript: string): VoiceMessageTranscriber {
  return {
    transcribeVoiceMessage: vi.fn<
      (request: VoiceMessageTranscriptionRequest) => Promise<VoiceMessageTranscriptionResult>
    >().mockImplementation(async (request) => {
      expect(request.mimeType).toBe("audio/ogg");
      expect(request.audioBuffer.length).toBeGreaterThan(0);

      return {
        transcript,
        confidence: 0.98,
      };
    }),
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppBot voice messages", () => {
  it("starts multiple call connect events in parallel when they arrive in one webhook", async () => {
    const client = createMockClient();
    const firstCall = createDeferredPromise();
    const secondCall = createDeferredPromise();
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: createTranscriber("unused"),
      fetchImplementation: vi.fn() as typeof fetch,
    });
    const handleConnectSpy = vi
      .spyOn(bot as any, "handleConnect")
      .mockImplementationOnce(async () => {
        await firstCall.promise;
      })
      .mockImplementationOnce(async () => {
        await secondCall.promise;
      });

    const webhookPromise = bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "calls",
              value: {
                calls: [
                  {
                    id: "call-1",
                    event: "connect",
                    from: "15551234567",
                    session: {
                      sdp_type: "offer",
                      sdp: "v=0",
                    },
                  },
                  {
                    id: "call-2",
                    event: "connect",
                    from: "15557654321",
                    session: {
                      sdp_type: "offer",
                      sdp: "v=0",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await vi.waitFor(() => {
      expect(handleConnectSpy).toHaveBeenCalledTimes(2);
    });

    firstCall.resolve();
    secondCall.resolve();
    await webhookPromise;
  });

  it("ignores duplicate connect events for the same call while setup is still in flight", async () => {
    const client = createMockClient();
    const activeCall = createDeferredPromise();
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: createTranscriber("unused"),
      fetchImplementation: vi.fn() as typeof fetch,
    });
    const handleConnectSpy = vi
      .spyOn(bot as any, "handleConnect")
      .mockImplementation(async () => {
        await activeCall.promise;
      });

    const webhookPromise = bot.handleWebhook({
      entry: [
        {
          changes: [
            {
              field: "calls",
              value: {
                calls: [
                  {
                    id: "call-1",
                    event: "connect",
                    from: "15551234567",
                    session: {
                      sdp_type: "offer",
                      sdp: "v=0",
                    },
                  },
                  {
                    id: "call-1",
                    event: "connect",
                    from: "15551234567",
                    session: {
                      sdp_type: "offer",
                      sdp: "v=0",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await vi.waitFor(() => {
      expect(handleConnectSpy).toHaveBeenCalledTimes(1);
    });

    activeCall.resolve();
    await webhookPromise;
  });

  it("routes a transcribed voice note through the text interaction agent", async () => {
    const client = createMockClient();
    const transcriber = createTranscriber("hello world");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: transcriber,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook(createAudioWebhookBody());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "https://graph.facebook.com/v23.0/123456789/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-access-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.voice",
          typing_indicator: {
            type: "text"
          }
        })
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://lookaside.fbsbx.com/test-audio",
      {
        headers: {
          Authorization: "Bearer test-access-token",
        },
      }
    );
    expect(client.media.getMediaById).not.toHaveBeenCalled();
    expect(textDeps.textConversationStore.prepareInboundTurn).toHaveBeenCalledWith({
      fromPhone: "15551234567",
      messageId: "wamid.voice",
      rawPayload: {
        originalMessage: expect.objectContaining({
          id: "wamid.voice",
          from: "15551234567",
          type: "audio",
        }),
        transcription: {
          confidence: 0.98,
          transcript: "hello world",
        },
      },
      text: "hello world",
    });
    expect(textDeps.textInteractionAgent.runTurn).toHaveBeenCalledTimes(1);
    expect(client.messages.text).toHaveBeenCalledTimes(1);
    expect(client.messages.text).toHaveBeenCalledWith({
      body: "mocked text reply",
      to: "15551234567",
      replyMessageId: "wamid.voice",
    });
  });

  it("does not send a reply for duplicate transcribed voice-note webhooks", async () => {
    const client = createMockClient();
    const transcriber = createTranscriber("check my inbox");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textDeps = createTextAgentDependencies();
    textDeps.textConversationStore.prepareInboundTurn.mockResolvedValue({
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      status: "duplicate",
      turn: null,
    } satisfies PreparedInboundTextTurnResultDto);
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: transcriber,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook(createAudioWebhookBody());

    expect(textDeps.textInteractionAgent.runTurn).not.toHaveBeenCalled();
    expect(client.messages.text).not.toHaveBeenCalled();
  });

  it("sends a clear failure message when transcription throws", async () => {
    const client = createMockClient();
    const transcriber: VoiceMessageTranscriber = {
      transcribeVoiceMessage: vi.fn().mockRejectedValue(new Error("Deepgram error")),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: transcriber,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook(createAudioWebhookBody());

    expect(client.messages.text).toHaveBeenCalledWith({
      body: "I couldn't transcribe your voice message. Please try again.",
      to: "15551234567",
      replyMessageId: "wamid.voice",
    });
  });

  it("falls back to getMediaById when the webhook audio object does not include a media URL", async () => {
    const client = createMockClient();
    const transcriber = createTranscriber("hello world");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: transcriber,
      fetchImplementation: fetchMock as typeof fetch,
    });

    const body = createAudioWebhookBody();
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.audio) {
      throw new Error("Test audio payload is missing");
    }

    delete message.audio.url;

    await bot.handleWebhook(body);

    expect(client.media.getMediaById).toHaveBeenCalledWith("media-123");
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://graph.facebook.com/test-audio",
      {
        headers: {
          Authorization: "Bearer test-access-token",
        },
      }
    );
  });

  it("sends a typing indicator before text-message processing starts", async () => {
    const client = createMockClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const textDeps = createTextAgentDependencies();
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      textConversationStore: textDeps.textConversationStore as any,
      textInteractionAgent: textDeps.textInteractionAgent as any,
      voiceMessageTranscriber: createTranscriber("unused"),
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
                      body: "hello world",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-access-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.text",
          typing_indicator: {
            type: "text"
          }
        })
      }
    );
  });
});
