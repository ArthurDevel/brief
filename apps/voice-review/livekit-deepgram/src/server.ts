import "dotenv/config";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { postProcessPcm } from "./audio/postprocess.js";
import { callDeepgramTts } from "./lib/deepgram.js";
import { getEnv, type AppEnv } from "./lib/env.js";
import { int16PcmToWavBuffer } from "./lib/wav.js";
import { callXaiTts } from "./lib/xai.js";
import {
  AGENT_NAME,
  AVAILABLE_STT_PROVIDERS,
  AVAILABLE_TTS_PROVIDERS,
  AVAILABLE_VOICES,
  DEFAULT_SPEED,
  NUM_CHANNELS,
  SAMPLE_RATE,
  type ConversationMode,
  type SessionConfig,
  type SttProviderName,
  type TtsProviderName,
  getDefaultSttProvider,
  getDefaultTtsProvider,
  getDefaultVoice,
  isSttProvider,
  isTtsProvider,
  isVoiceSupported,
} from "./shared/constants.js";

// ============================================================================
// TYPES
// ============================================================================

interface GenerateRequest {
  ttsProvider?: string;
  voice?: string;
  speed?: number;
  text?: string;
}

interface LiveKitSessionRequest {
  ttsProvider?: string;
  sttProvider?: string;
  voice?: string;
  speed?: number;
  mode?: ConversationMode;
  demoBrief?: string;
}

interface OptionsResponse {
  ttsProviders: typeof AVAILABLE_TTS_PROVIDERS;
  sttProviders: typeof AVAILABLE_STT_PROVIDERS;
  voices: typeof AVAILABLE_VOICES;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_DEMO_BRIEF_CHARS = 2000;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads one required API key for the selected provider.
 * @param providerLabel - Human-readable provider label
 * @param apiKey - Candidate API key
 * @returns Valid API key
 */
function requireProviderApiKey(providerLabel: string, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`${providerLabel} API key is required for this provider.`);
  }

  return apiKey;
}

/**
 * Validates and normalizes one TTS provider value.
 * @param value - Raw provider value
 * @returns Supported TTS provider
 */
function parseTtsProvider(value: string | undefined): TtsProviderName {
  if (value && isTtsProvider(value)) {
    return value;
  }

  return getDefaultTtsProvider();
}

/**
 * Validates and normalizes one STT provider value.
 * @param value - Raw provider value
 * @returns Supported STT provider
 */
function parseSttProvider(value: string | undefined): SttProviderName {
  if (value && isSttProvider(value)) {
    return value;
  }

  return getDefaultSttProvider();
}

/**
 * Validates the requested voice for the selected provider.
 * @param provider - Selected TTS provider
 * @param voice - Raw voice ID
 * @returns Supported voice ID
 */
function parseVoice(provider: TtsProviderName, voice: string | undefined): string {
  if (voice && isVoiceSupported(provider, voice)) {
    return voice;
  }

  return getDefaultVoice(provider);
}

/**
 * Validates and normalizes the session config sent by the browser.
 * @param input - Raw request body
 * @returns Valid session config
 */
function validateSessionConfig(input: LiveKitSessionRequest): SessionConfig {
  const ttsProvider = parseTtsProvider(input.ttsProvider);
  const mode: ConversationMode = input.mode === "demo" ? "demo" : "chat";
  const demoBrief =
    typeof input.demoBrief === "string"
      ? input.demoBrief.trim().slice(0, MAX_DEMO_BRIEF_CHARS)
      : "";

  return {
    ttsProvider,
    sttProvider: parseSttProvider(input.sttProvider),
    voice: parseVoice(ttsProvider, typeof input.voice === "string" ? input.voice : undefined),
    speed: typeof input.speed === "number" ? input.speed : DEFAULT_SPEED,
    mode,
    demoBrief: demoBrief || undefined,
  };
}

/**
 * Creates one participant token for the browser client.
 * @param roomName - LiveKit room name
 * @param metadata - Serialized session metadata
 * @returns JWT token for the browser client
 */
async function createParticipantToken(
  roomName: string,
  metadata: string
): Promise<string> {
  const env = getEnv();
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: `reviewer-${randomUUID()}`,
    name: "Voice Reviewer",
    metadata,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}

/**
 * Synthesizes preview PCM for the selected provider.
 * @param provider - Selected TTS provider
 * @param voiceId - Selected voice ID
 * @param text - Input text
 * @param env - App environment
 * @returns PCM16 audio samples
 */
async function synthesizePreviewPcm(
  provider: TtsProviderName,
  voiceId: string,
  text: string,
  env: AppEnv
): Promise<Int16Array> {
  if (provider === "xai") {
    return await callXaiTts(text, voiceId, requireProviderApiKey("xAI", env.xaiApiKey), SAMPLE_RATE);
  }

  return await callDeepgramTts(
    text,
    voiceId,
    requireProviderApiKey("Deepgram", env.deepgramApiKey),
    SAMPLE_RATE
  );
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const env = getEnv();
const roomClient = new RoomServiceClient(env.livekitHttpUrl, env.livekitApiKey, env.livekitApiSecret);
const dispatchClient = new AgentDispatchClient(
  env.livekitHttpUrl,
  env.livekitApiKey,
  env.livekitApiSecret
);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns the available review providers and voices.
 * @returns JSON response with provider and voice options
 */
app.get("/api/options", (_req, res: express.Response<OptionsResponse>) => {
  res.json({
    ttsProviders: AVAILABLE_TTS_PROVIDERS,
    sttProviders: AVAILABLE_STT_PROVIDERS,
    voices: AVAILABLE_VOICES,
  });
});

/**
 * Generates a WAV preview for one TTS provider and voice.
 * @returns WAV audio response
 */
app.post("/generate", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as GenerateRequest;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const ttsProvider = parseTtsProvider(body.ttsProvider);
    const voice = parseVoice(ttsProvider, typeof body.voice === "string" ? body.voice : undefined);
    const speed = typeof body.speed === "number" ? body.speed : DEFAULT_SPEED;
    const rawPcm = await synthesizePreviewPcm(ttsProvider, voice, text, env);
    const processed = postProcessPcm(rawPcm, {
      speed,
      sampleRate: SAMPLE_RATE,
      numChannels: NUM_CHANNELS,
    });
    const wav = int16PcmToWavBuffer(processed, SAMPLE_RATE, NUM_CHANNELS);

    res.setHeader("Content-Type", "audio/wav");
    res.send(wav);
  } catch (error) {
    next(error);
  }
});

/**
 * Creates one LiveKit room and dispatches the review worker.
 * @returns JSON session payload for the browser client
 */
app.post("/api/livekit/session", async (req, res, next) => {
  try {
    const config = validateSessionConfig(req.body ?? {});
    const metadata = JSON.stringify(config);
    const roomName = `livekit-review-${randomUUID()}`;

    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 60,
      departureTimeout: 30,
      maxParticipants: 4,
    });

    await dispatchClient.createDispatch(roomName, AGENT_NAME, { metadata });
    const token = await createParticipantToken(roomName, metadata);

    res.json({
      roomName,
      token,
      url: env.livekitWsUrl,
    });
  } catch (error) {
    next(error);
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(currentDir, "../static");

app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
);

app.listen(env.port, () => {
  console.log(`LiveKit review server listening on http://localhost:${env.port}`);
});
