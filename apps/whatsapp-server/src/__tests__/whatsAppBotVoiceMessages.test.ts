import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppBot, type WhatsAppWebhookBody } from "../whatsAppBot.js";
import type {
  VoiceMessageTranscriber,
  VoiceMessageTranscriptionRequest,
  VoiceMessageTranscriptionResult,
} from "../deepgramVoiceMessageTranscriber.js";

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
  it("reuses the text handler when a voice note transcribes to hello world", async () => {
    const client = createMockClient();
    const transcriber = createTranscriber("hello world");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
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
    expect(client.messages.text).toHaveBeenCalledTimes(1);
    expect(client.messages.text).toHaveBeenCalledWith({
      body: "received",
      to: "15551234567",
      replyMessageId: "wamid.voice",
    });
  });

  it("echoes the transcript back when the voice note does not match an existing text flow", async () => {
    const client = createMockClient();
    const transcriber = createTranscriber("check my inbox");
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
      voiceMessageTranscriber: transcriber,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await bot.handleWebhook(createAudioWebhookBody());

    expect(client.messages.text).toHaveBeenCalledWith({
      body: "I transcribed your voice message as:\n\ncheck my inbox",
      to: "15551234567",
      replyMessageId: "wamid.voice",
    });
  });

  it("sends a clear failure message when transcription throws", async () => {
    const client = createMockClient();
    const transcriber: VoiceMessageTranscriber = {
      transcribeVoiceMessage: vi.fn().mockRejectedValue(new Error("Deepgram error")),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("voice-note"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
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
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
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
    const bot = new WhatsAppBot({
      client: client as any,
      roomManager: {
        createCallSession: vi.fn(),
        cleanupCallSession: vi.fn(),
      },
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
