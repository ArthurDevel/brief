/**
 * WhatsApp voice configuration helpers for the LiveKit agent.
 *
 * Responsibilities:
 * - Define the WhatsApp voice config DTO
 * - Parse persisted WhatsApp voice settings
 * - Create the provider-backed TTS instance for the caller
 */

import type { tts } from "@livekit/agents";
import { ProcessedDeepgramTTS } from "./tts/processedDeepgramTts.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_WHATSAPP_VOICE_PROVIDER = "deepgram";
const DEFAULT_WHATSAPP_VOICE_ID = "aura-2-andromeda-en";
const DEFAULT_WHATSAPP_VOICE_SPEED = 1.2;
const MIN_WHATSAPP_VOICE_SPEED = 1.0;
const MAX_WHATSAPP_VOICE_SPEED = 1.5;

export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;

// ============================================================================
// TYPES
// ============================================================================

export type WhatsAppVoiceProviderName = "deepgram";

export interface WhatsAppVoiceConfig {
  provider: WhatsAppVoiceProviderName;
  voiceId: string;
  speed: number;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the default WhatsApp voice config.
 * @returns Default WhatsApp voice config
 */
export function getDefaultWhatsAppVoiceConfig(): WhatsAppVoiceConfig {
  return {
    provider: ACTIVE_WHATSAPP_VOICE_PROVIDER,
    voiceId: DEFAULT_WHATSAPP_VOICE_ID,
    speed: DEFAULT_WHATSAPP_VOICE_SPEED,
  };
}

/**
 * Parses the persisted WhatsApp voice config from user_settings.
 * @param value - Raw JSON value from user_settings.whatsapp_voice_config
 * @returns Parsed WhatsApp voice config
 */
export function parseStoredWhatsAppVoiceConfig(value: unknown): WhatsAppVoiceConfig {
  if (value == null) {
    return getDefaultWhatsAppVoiceConfig();
  }

  const candidate = value as Partial<WhatsAppVoiceConfig>;
  if (candidate.provider !== ACTIVE_WHATSAPP_VOICE_PROVIDER) {
    throw new Error("The stored WhatsApp voice provider is invalid.");
  }

  if (typeof candidate.voiceId !== "string" || candidate.voiceId.trim().length === 0) {
    throw new Error("The stored WhatsApp voice ID is invalid.");
  }

  if (typeof candidate.speed !== "number" || Number.isNaN(candidate.speed)) {
    throw new Error("The stored WhatsApp voice speed is invalid.");
  }

  assertSpeedInRange(candidate.speed);

  return {
    provider: candidate.provider,
    voiceId: candidate.voiceId.trim(),
    speed: candidate.speed,
  };
}

/**
 * Creates the provider-backed TTS instance for the caller.
 * @param deepgramApiKey - Deepgram API key
 * @param config - Caller-specific WhatsApp voice config
 * @returns LiveKit TTS instance
 */
export function createWhatsAppTts(
  deepgramApiKey: string,
  config: WhatsAppVoiceConfig
): tts.TTS {
  if (config.provider !== "deepgram") {
    throw new Error(`WhatsApp TTS provider "${config.provider}" is not implemented.`);
  }

  return new ProcessedDeepgramTTS({
    apiKey: deepgramApiKey,
    model: config.voiceId,
    speed: config.speed,
    sampleRate: SAMPLE_RATE,
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Ensures the stored speed is supported.
 * @param speed - Candidate speed value
 * @returns Nothing. Throws when invalid.
 */
function assertSpeedInRange(speed: number): void {
  if (speed < MIN_WHATSAPP_VOICE_SPEED || speed > MAX_WHATSAPP_VOICE_SPEED) {
    throw new Error(
      `WhatsApp voice speed must be between ${MIN_WHATSAPP_VOICE_SPEED} and ${MAX_WHATSAPP_VOICE_SPEED}.`
    );
  }
}
