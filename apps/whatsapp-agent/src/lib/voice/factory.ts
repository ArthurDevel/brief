/**
 * Factory for WhatsApp voice provider runtime instances.
 *
 * Responsibilities:
 * - Create the configured LiveKit STT input
 * - Create the configured LiveKit TTS provider
 * - Fail fast when selected providers are invalid or missing credentials
 */

import type { stt, tts } from "@livekit/agents";
import type { AgentEnv } from "../env.js";
import { createDeepgramStt, ProcessedDeepgramTTS } from "./providers/deepgram.js";
import { createXaiStt, ProcessedXaiTTS } from "./providers/xai.js";
import {
  getDefaultWhatsAppSttProvider,
  getDefaultWhatsAppTtsProvider,
  parseWhatsAppSpeechProvider,
  resolveWhatsAppVoiceConfigForProvider,
  SAMPLE_RATE,
  type WhatsAppVoiceConfig,
} from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

export type WhatsAppSttRuntime = stt.STT | string;

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Creates the configured WhatsApp STT runtime.
 * @param env - Loaded app environment
 * @returns LiveKit STT instance or model descriptor
 */
export function createWhatsAppStt(env: AgentEnv): WhatsAppSttRuntime {
  const provider = parseWhatsAppSpeechProvider(
    env.whatsappSttProvider || getDefaultWhatsAppSttProvider(),
    "WHATSAPP_STT_PROVIDER"
  );

  if (provider === "xai") {
    return createXaiStt(env.whatsappXaiSttModel);
  }

  return createDeepgramStt(env.whatsappDeepgramSttModel);
}

/**
 * Creates the configured WhatsApp TTS runtime.
 * @param env - Loaded app environment
 * @param voiceConfig - Caller-specific voice config
 * @returns LiveKit TTS instance
 */
export function createWhatsAppTts(
  env: AgentEnv,
  voiceConfig: WhatsAppVoiceConfig
): tts.TTS {
  const provider = parseWhatsAppSpeechProvider(
    env.whatsappTtsProvider || getDefaultWhatsAppTtsProvider(),
    "WHATSAPP_TTS_PROVIDER"
  );

  const resolvedVoiceConfig = resolveWhatsAppVoiceConfigForProvider(provider, voiceConfig, {
    deepgramVoiceId: env.whatsappDefaultDeepgramVoice,
    xaiVoiceId: env.whatsappDefaultXaiVoice,
  });

  if (provider === "xai") {
    return new ProcessedXaiTTS({
      apiKey: requireProviderApiKey("XAI_API_KEY", env.xaiApiKey),
      voiceId: resolvedVoiceConfig.voiceId,
      speed: resolvedVoiceConfig.speed,
      sampleRate: SAMPLE_RATE,
    });
  }

  return new ProcessedDeepgramTTS({
    apiKey: requireProviderApiKey("DEEPGRAM_API_KEY", env.deepgramApiKey),
    model: resolvedVoiceConfig.voiceId,
    speed: resolvedVoiceConfig.speed,
    sampleRate: SAMPLE_RATE,
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns one provider API key or throws a clear configuration error.
 * @param name - Environment variable name
 * @param value - Candidate key value
 * @returns Provider API key
 */
function requireProviderApiKey(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required for the selected WhatsApp voice provider.`);
  }

  return value;
}
