/**
 * Transcribes inbound WhatsApp voice messages with Deepgram.
 *
 * Responsibilities:
 * - Validate the Deepgram configuration required for transcription
 * - Submit pre-recorded audio bytes to Deepgram's STT API
 * - Return a simple transcript DTO for the WhatsApp server
 */

// ============================================================================
// TYPES
// ============================================================================

export interface VoiceMessageTranscriptionRequest {
  audioBuffer: Buffer;
  mimeType: string;
}

export interface VoiceMessageTranscriptionResult {
  transcript: string;
  confidence: number | null;
}

interface DeepgramTranscriptionAlternative {
  transcript?: string;
  confidence?: number;
}

interface DeepgramTranscriptionChannel {
  alternatives?: DeepgramTranscriptionAlternative[];
}

interface DeepgramTranscriptionResults {
  channels?: DeepgramTranscriptionChannel[];
}

interface DeepgramTranscriptionResponse {
  results?: DeepgramTranscriptionResults;
}

export interface VoiceMessageTranscriber {
  /**
   * Transcribes a pre-recorded voice message.
   * @param request - Audio bytes and MIME type to send to Deepgram
   * @returns Transcript text and confidence when available
   */
  transcribeVoiceMessage(
    request: VoiceMessageTranscriptionRequest
  ): Promise<VoiceMessageTranscriptionResult>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_DEEPGRAM_MODEL = "nova-3";

// ============================================================================
// MAIN CLASS
// ============================================================================

export class DeepgramVoiceMessageTranscriber implements VoiceMessageTranscriber {
  private readonly fetchImplementation: typeof fetch;

  /**
   * Creates a Deepgram voice-message transcriber.
   * @param fetchImplementation - Fetch implementation used for HTTP requests
   */
  constructor(fetchImplementation: typeof fetch = fetch) {
    this.fetchImplementation = fetchImplementation;
  }

  /**
   * Sends audio bytes to Deepgram and returns the transcript.
   * @param request - Audio bytes and MIME type to send to Deepgram
   * @returns Transcript text and confidence when available
   */
  async transcribeVoiceMessage(
    request: VoiceMessageTranscriptionRequest
  ): Promise<VoiceMessageTranscriptionResult> {
    const apiKey = requireEnv("DEEPGRAM_API_KEY");
    const response = await this.fetchImplementation(buildDeepgramListenUrl(), {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": request.mimeType,
      },
      body: request.audioBuffer,
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Deepgram transcription failed: ${payload}`);
    }

    const payload = (await response.json()) as DeepgramTranscriptionResponse;
    const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alternative?.transcript?.trim() ?? "";

    if (!transcript) {
      throw new Error("Deepgram transcription returned an empty transcript");
    }

    return {
      transcript,
      confidence: typeof alternative?.confidence === "number" ? alternative.confidence : null,
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the Deepgram prerecorded transcription URL.
 * @returns Full Deepgram listen URL with query parameters
 */
function buildDeepgramListenUrl(): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set("model", DEFAULT_DEEPGRAM_MODEL);
  url.searchParams.set("smart_format", "true");
  return url.toString();
}

/**
 * Loads a required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }

  return value;
}
