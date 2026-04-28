/**
 * WhatsApp voice provider types and validation helpers.
 *
 * Responsibilities:
 * - Define supported STT and TTS provider names
 * - Define persisted WhatsApp voice config DTOs
 * - Validate provider names, voice IDs, and voice speed
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;

const DEFAULT_STT_PROVIDER: WhatsAppSpeechProviderName = "deepgram";
const DEFAULT_TTS_PROVIDER: WhatsAppSpeechProviderName = "deepgram";
const DEFAULT_DEEPGRAM_VOICE_ID = "aura-2-andromeda-en";
const DEFAULT_XAI_VOICE_ID = "ara";
const DEFAULT_WHATSAPP_VOICE_SPEED = 1.2;
const MIN_WHATSAPP_VOICE_SPEED = 1.0;
const MAX_WHATSAPP_VOICE_SPEED = 1.5;

const SUPPORTED_DEEPGRAM_VOICE_IDS = [
  "aura-2-andromeda-en",
  "aura-2-delia-en",
  "aura-2-electra-en",
  "aura-2-vesta-en",
  "aura-2-mars-en",
  "aura-2-odysseus-en",
  "aura-2-orpheus-en",
  "aura-2-zeus-en",
] as const;

const SUPPORTED_XAI_VOICE_IDS = [
  "ara",
  "eve",
  "leo",
  "rex",
  "sal",
] as const;

// ============================================================================
// TYPES
// ============================================================================

export type WhatsAppSpeechProviderName = "deepgram" | "xai";
export type WhatsAppVoiceProviderName = WhatsAppSpeechProviderName;

export interface WhatsAppVoiceConfig {
  provider: WhatsAppVoiceProviderName;
  voiceId: string;
  speed: number;
}

export interface WhatsAppVoiceProviderDefaultIds {
  deepgramVoiceId?: string;
  xaiVoiceId?: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the default STT provider.
 * @returns Default STT provider name
 */
export function getDefaultWhatsAppSttProvider(): WhatsAppSpeechProviderName {
  return DEFAULT_STT_PROVIDER;
}

/**
 * Returns the default TTS provider.
 * @returns Default TTS provider name
 */
export function getDefaultWhatsAppTtsProvider(): WhatsAppSpeechProviderName {
  return DEFAULT_TTS_PROVIDER;
}

/**
 * Returns the default WhatsApp voice config.
 * @returns Default WhatsApp voice config
 */
export function getDefaultWhatsAppVoiceConfig(
  defaults: WhatsAppVoiceProviderDefaultIds = {}
): WhatsAppVoiceConfig {
  return {
    provider: DEFAULT_TTS_PROVIDER,
    voiceId: getDefaultWhatsAppVoiceId(DEFAULT_TTS_PROVIDER, defaults),
    speed: DEFAULT_WHATSAPP_VOICE_SPEED,
  };
}

/**
 * Returns the default voice ID for a TTS provider.
 * @param provider - TTS provider name
 * @returns Default provider voice ID
 */
export function getDefaultWhatsAppVoiceId(
  provider: WhatsAppVoiceProviderName,
  defaults: WhatsAppVoiceProviderDefaultIds = {}
): string {
  if (provider === "xai") {
    return defaults.xaiVoiceId?.trim() || DEFAULT_XAI_VOICE_ID;
  }

  return defaults.deepgramVoiceId?.trim() || DEFAULT_DEEPGRAM_VOICE_ID;
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
  const provider = parseWhatsAppSpeechProvider(candidate.provider, "stored WhatsApp voice provider");

  if (typeof candidate.voiceId !== "string" || candidate.voiceId.trim().length === 0) {
    throw new Error("The stored WhatsApp voice ID is invalid.");
  }

  const voiceId = candidate.voiceId.trim();
  if (!isWhatsAppVoiceSupported(provider, voiceId)) {
    throw new Error(`The stored WhatsApp voice ID "${voiceId}" is not supported for ${provider}.`);
  }

  if (typeof candidate.speed !== "number" || Number.isNaN(candidate.speed)) {
    throw new Error("The stored WhatsApp voice speed is invalid.");
  }

  assertWhatsAppVoiceSpeedInRange(candidate.speed);

  return {
    provider,
    voiceId,
    speed: candidate.speed,
  };
}

/**
 * Resolves a caller voice config for the selected runtime provider.
 * @param provider - Selected TTS provider
 * @param voiceConfig - Stored caller voice config
 * @param defaults - Optional provider-specific default voice IDs
 * @returns Voice config that belongs to the selected provider
 */
export function resolveWhatsAppVoiceConfigForProvider(
  provider: WhatsAppVoiceProviderName,
  voiceConfig: WhatsAppVoiceConfig,
  defaults: WhatsAppVoiceProviderDefaultIds = {}
): WhatsAppVoiceConfig {
  assertWhatsAppVoiceSpeedInRange(voiceConfig.speed);

  if (voiceConfig.provider === provider) {
    if (!isWhatsAppVoiceSupported(provider, voiceConfig.voiceId)) {
      throw new Error(`WhatsApp voice ID "${voiceConfig.voiceId}" is not supported for ${provider}.`);
    }

    return voiceConfig;
  }

  const defaultVoiceId = getDefaultWhatsAppVoiceId(provider, defaults);
  if (!isWhatsAppVoiceSupported(provider, defaultVoiceId)) {
    throw new Error(`Default WhatsApp voice ID "${defaultVoiceId}" is not supported for ${provider}.`);
  }

  return {
    provider,
    voiceId: defaultVoiceId,
    speed: voiceConfig.speed,
  };
}

/**
 * Parses one provider value from env or persisted config.
 * @param value - Raw provider value
 * @param label - Human-readable value label for errors
 * @returns Supported provider name
 */
export function parseWhatsAppSpeechProvider(
  value: string | undefined,
  label: string
): WhatsAppSpeechProviderName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deepgram" || normalized === "xai") {
    return normalized;
  }

  throw new Error(`${label} must be "deepgram" or "xai". Received "${value ?? ""}".`);
}

/**
 * Returns true when a provider can use one voice ID.
 * @param provider - TTS provider name
 * @param voiceId - Candidate voice ID
 * @returns Whether the voice is supported for the provider
 */
export function isWhatsAppVoiceSupported(
  provider: WhatsAppVoiceProviderName,
  voiceId: string
): boolean {
  if (provider === "xai") {
    return SUPPORTED_XAI_VOICE_IDS.includes(voiceId as (typeof SUPPORTED_XAI_VOICE_IDS)[number]);
  }

  return SUPPORTED_DEEPGRAM_VOICE_IDS.includes(
    voiceId as (typeof SUPPORTED_DEEPGRAM_VOICE_IDS)[number]
  );
}

/**
 * Ensures the stored speed is supported.
 * @param speed - Candidate speed value
 * @returns Nothing. Throws when invalid.
 */
export function assertWhatsAppVoiceSpeedInRange(speed: number): void {
  if (speed < MIN_WHATSAPP_VOICE_SPEED || speed > MAX_WHATSAPP_VOICE_SPEED) {
    throw new Error(
      `WhatsApp voice speed must be between ${MIN_WHATSAPP_VOICE_SPEED} and ${MAX_WHATSAPP_VOICE_SPEED}.`
    );
  }
}
