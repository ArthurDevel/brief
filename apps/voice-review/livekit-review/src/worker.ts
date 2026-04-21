import "dotenv/config";

import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  JobContext,
  JobProcess,
  WorkerOptions,
  voice,
  cli,
  defineAgent,
  type stt,
  type tts,
} from "@livekit/agents";
import { STTv2 } from "@livekit/agents-plugin-deepgram";
import { LLM as OpenAILLM } from "@livekit/agents-plugin-openai";
import { VAD } from "@livekit/agents-plugin-silero";
import { STT as XaiSTT } from "@livekit/agents-plugin-xai";
import { getEnv, type AppEnv } from "./lib/env.js";
import {
  AGENT_NAME,
  buildGreetingInstructions,
  buildSystemPrompt,
  DEFAULT_SPEED,
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
import { ProcessedDeepgramTTS } from "./tts/processedDeepgramTts.js";
import { XaiTTS } from "./tts/xaiTts.js";

// ============================================================================
// TYPES
// ============================================================================

interface WorkerUserData {
  vad?: VAD;
}

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
 * Parses session metadata into a validated config.
 * @param metadata - Raw LiveKit metadata JSON
 * @returns Session config with safe defaults
 */
function parseConfig(metadata: string): SessionConfig {
  try {
    const parsed = JSON.parse(metadata) as Partial<SessionConfig>;
    const rawTtsProvider = typeof parsed.ttsProvider === "string" ? parsed.ttsProvider : "";
    const rawSttProvider = typeof parsed.sttProvider === "string" ? parsed.sttProvider : "";
    const ttsProvider = isTtsProvider(rawTtsProvider) ? rawTtsProvider : getDefaultTtsProvider();
    const sttProvider = isSttProvider(rawSttProvider) ? rawSttProvider : getDefaultSttProvider();
    const defaultVoice = getDefaultVoice(ttsProvider);
    const voice =
      typeof parsed.voice === "string" && isVoiceSupported(ttsProvider, parsed.voice)
        ? parsed.voice
        : defaultVoice;

    return {
      ttsProvider,
      sttProvider,
      voice,
      speed: typeof parsed.speed === "number" ? parsed.speed : DEFAULT_SPEED,
      mode: parsed.mode === "demo" ? "demo" : "chat",
      demoBrief: typeof parsed.demoBrief === "string" ? parsed.demoBrief.trim() : undefined,
    };
  } catch {
    const ttsProvider = getDefaultTtsProvider();
    return {
      ttsProvider,
      sttProvider: getDefaultSttProvider(),
      voice: getDefaultVoice(ttsProvider),
      speed: DEFAULT_SPEED,
      mode: "chat",
    };
  }
}

/**
 * Creates the STT instance for the selected provider.
 * @param provider - Selected STT provider
 * @param env - App environment
 * @returns LiveKit STT instance
 */
function createStt(provider: SttProviderName, env: AppEnv): stt.STT {
  if (provider === "xai") {
    return new XaiSTT({
      apiKey: requireProviderApiKey("xAI", env.xaiApiKey),
      language: "en",
      interimResults: true,
    });
  }

  return new STTv2({
    apiKey: requireProviderApiKey("Deepgram", env.deepgramApiKey),
    model: "flux-general-en",
    sampleRate: 16000,
  });
}

/**
 * Creates the TTS instance for the selected provider.
 * @param provider - Selected TTS provider
 * @param voiceId - Selected voice ID
 * @param speed - Playback speed multiplier
 * @param env - App environment
 * @returns LiveKit TTS instance
 */
function createTts(
  provider: TtsProviderName,
  voiceId: string,
  speed: number,
  env: AppEnv
): tts.TTS {
  if (provider === "xai") {
    return new XaiTTS({
      apiKey: requireProviderApiKey("xAI", env.xaiApiKey),
      voice: voiceId,
      speed,
    });
  }

  return new ProcessedDeepgramTTS({
    apiKey: requireProviderApiKey("Deepgram", env.deepgramApiKey),
    model: voiceId,
    speed,
  });
}

// ============================================================================
// MAIN ENTRYPOINTS
// ============================================================================

const env = getEnv();

/**
 * Preloads the VAD model once per worker process.
 * @param proc - LiveKit worker process
 * @returns Nothing
 */
async function prewarm(proc: JobProcess): Promise<void> {
  const userData = proc.userData as WorkerUserData;
  userData.vad = await VAD.load();
}

/**
 * Handles one LiveKit voice review session.
 * @param ctx - LiveKit job context
 * @returns Nothing
 */
async function entry(ctx: JobContext): Promise<void> {
  const config = parseConfig(ctx.job.metadata);
  const userData = ctx.proc.userData as WorkerUserData;

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

  const session = new voice.AgentSession({
    vad: userData.vad,
    stt: createStt(config.sttProvider, env),
    llm: new OpenAILLM({
      apiKey: env.openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
      model: env.openrouterModel,
    }),
    tts: createTts(config.ttsProvider, config.voice, config.speed, env),
    useTtsAlignedTranscript: false,
  });

  const agent = new voice.Agent({
    instructions: buildSystemPrompt(config),
  });

  const closed = new Promise<void>((resolve) => {
    session.on(voice.AgentSessionEventTypes.Close, () => resolve());
  });

  await session.start({
    agent,
    room: ctx.room,
    record: false,
  });

  await ctx.waitForParticipant();
  session.generateReply({
    instructions: buildGreetingInstructions(config),
  });

  await closed;
}

const worker = defineAgent({
  prewarm,
  entry,
});

export default worker;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: AGENT_NAME,
      wsURL: env.livekitWsUrl,
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret,
    })
  );
}
