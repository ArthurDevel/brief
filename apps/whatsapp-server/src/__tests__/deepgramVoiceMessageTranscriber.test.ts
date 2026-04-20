import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeepgramVoiceMessageTranscriber,
  type VoiceMessageTranscriptionRequest,
} from "../deepgramVoiceMessageTranscriber.js";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a valid voice transcription request payload.
 * @returns Request object with audio bytes and MIME type
 */
function createRequest(): VoiceMessageTranscriptionRequest {
  return {
    audioBuffer: Buffer.from("voice-note"),
    mimeType: "audio/ogg",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================================
// TESTS
// ============================================================================

describe("DeepgramVoiceMessageTranscriber", () => {
  it("returns the first transcript alternative", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: "authenticate overview",
                    confidence: 0.99,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const transcriber = new DeepgramVoiceMessageTranscriber(fetchMock as typeof fetch);
    const result = await transcriber.transcribeVoiceMessage(createRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
      {
        method: "POST",
        headers: {
          Authorization: "Token test-key",
          "Content-Type": "audio/ogg",
        },
        body: Buffer.from("voice-note"),
      }
    );
    expect(result).toEqual({
      transcript: "authenticate overview",
      confidence: 0.99,
    });
  });

  it("throws when Deepgram returns an empty transcript", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: "   ",
                    confidence: 0.1,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const transcriber = new DeepgramVoiceMessageTranscriber(fetchMock as typeof fetch);

    await expect(transcriber.transcribeVoiceMessage(createRequest())).rejects.toThrow(
      "Deepgram transcription returned an empty transcript"
    );
  });

  it("throws when Deepgram returns a non-200 response", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const transcriber = new DeepgramVoiceMessageTranscriber(fetchMock as typeof fetch);

    await expect(transcriber.transcribeVoiceMessage(createRequest())).rejects.toThrow(
      "Deepgram transcription failed: bad request"
    );
  });
});
