/**
 * WhatsApp-specific voice settings helpers.
 *
 * Responsibilities:
 * - Define the WhatsApp voice config DTO
 * - Load voice options from the active WhatsApp voice provider
 * - Validate saved and incoming WhatsApp voice settings
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_WHATSAPP_VOICE_PROVIDER = "deepgram";
const DEFAULT_WHATSAPP_VOICE_ID = "aura-2-andromeda-en";
const DEFAULT_WHATSAPP_VOICE_SPEED = 1.2;
const MIN_WHATSAPP_VOICE_SPEED = 1.0;
const MAX_WHATSAPP_VOICE_SPEED = 1.5;
const WHATSAPP_VOICE_OPTIONS_REVALIDATE_SECONDS = 3600;

// ============================================================================
// TYPES
// ============================================================================

export type WhatsAppVoiceProviderName = "deepgram";

export interface WhatsAppVoiceConfig {
  provider: WhatsAppVoiceProviderName;
  voiceId: string;
  speed: number;
}

export interface WhatsAppVoiceOption {
  id: string;
  label: string;
  accent: string | null;
  previewUrl: string | null;
  provider: WhatsAppVoiceProviderName;
}

interface DeepgramModelMetadata {
  accent?: string;
  sample?: string;
}

interface DeepgramModel {
  name: string;
  canonical_name: string;
  languages: string[];
  metadata?: DeepgramModelMetadata;
}

interface DeepgramModelsResponse {
  tts?: DeepgramModel[];
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the current default WhatsApp voice config.
 * @returns Default voice config for WhatsApp calls
 */
export function getDefaultWhatsAppVoiceConfig(): WhatsAppVoiceConfig {
  return {
    provider: ACTIVE_WHATSAPP_VOICE_PROVIDER,
    voiceId: DEFAULT_WHATSAPP_VOICE_ID,
    speed: DEFAULT_WHATSAPP_VOICE_SPEED,
  };
}

/**
 * Loads the available WhatsApp voice options from the active provider.
 * @returns Normalized voice options for the WhatsApp settings page
 */
export async function listWhatsAppVoiceOptions(): Promise<WhatsAppVoiceOption[]> {
  if (ACTIVE_WHATSAPP_VOICE_PROVIDER === "deepgram") {
    return await listDeepgramVoiceOptions();
  }

  throw new Error(`WhatsApp voice provider "${ACTIVE_WHATSAPP_VOICE_PROVIDER}" is not implemented.`);
}

/**
 * Parses the stored WhatsApp voice config row.
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

  assertVoiceSpeedInRange(candidate.speed);

  return {
    provider: candidate.provider,
    voiceId: candidate.voiceId.trim(),
    speed: candidate.speed,
  };
}

/**
 * Parses an incoming voice settings update request.
 * @param body - Raw JSON request body
 * @returns Validated WhatsApp voice config to persist
 */
export function parseWhatsAppVoiceUpdate(body: unknown): WhatsAppVoiceConfig {
  const candidate = body as {
    voiceId?: unknown;
    speed?: unknown;
  } | null;

  if (!candidate || typeof candidate.voiceId !== "string" || candidate.voiceId.trim().length === 0) {
    throw new Error("Enter a valid WhatsApp voice.");
  }

  if (typeof candidate.speed !== "number" || Number.isNaN(candidate.speed)) {
    throw new Error("Enter a valid WhatsApp voice speed.");
  }

  assertVoiceSpeedInRange(candidate.speed);

  return {
    provider: ACTIVE_WHATSAPP_VOICE_PROVIDER,
    voiceId: candidate.voiceId.trim(),
    speed: candidate.speed,
  };
}

/**
 * Validates that a config references a currently available option.
 * @param config - Voice config to validate
 * @param options - Current provider-backed voice options
 * @returns Nothing. Throws when the config is invalid.
 */
export function validateWhatsAppVoiceConfig(
  config: WhatsAppVoiceConfig,
  options: WhatsAppVoiceOption[]
): void {
  assertVoiceSpeedInRange(config.speed);

  const matchingVoice = options.find((option) => {
    return option.provider === config.provider && option.id === config.voiceId;
  });

  if (!matchingVoice) {
    throw new Error(`WhatsApp voice "${config.voiceId}" is not available.`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads and normalizes Deepgram voice models for WhatsApp.
 * @returns Deepgram voices exposed through the WhatsApp settings page
 */
async function listDeepgramVoiceOptions(): Promise<WhatsAppVoiceOption[]> {
  const apiKey = requireEnv("DEEPGRAM_API_KEY");
  const response = await fetch("https://api.deepgram.com/v1/models", {
    headers: {
      Authorization: `Token ${apiKey}`,
    },
    next: {
      revalidate: WHATSAPP_VOICE_OPTIONS_REVALIDATE_SECONDS,
    },
  });

  if (!response.ok) {
    throw new Error(`Deepgram voice options request failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as DeepgramModelsResponse;
  const voices = Array.isArray(payload.tts) ? payload.tts : [];

  return voices
    .filter(isSupportedDeepgramVoice)
    .map((voice) => ({
      id: voice.canonical_name.trim(),
      label: toTitleCase(voice.name),
      accent: voice.metadata?.accent?.trim() || null,
      previewUrl: voice.metadata?.sample?.trim() || null,
      provider: "deepgram" as const,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Returns true when a Deepgram voice should be exposed in WhatsApp.
 * @param voice - Deepgram TTS model candidate
 * @returns Whether the voice is supported
 */
function isSupportedDeepgramVoice(voice: DeepgramModel): boolean {
  const canonicalName = voice.canonical_name.trim();
  const supportsEnglish = voice.languages.some((language) => language.startsWith("en"));
  return canonicalName.startsWith("aura-2-") && supportsEnglish;
}

/**
 * Ensures the selected speed is supported.
 * @param speed - Candidate speed value
 * @returns Nothing. Throws when the speed is outside the supported range.
 */
function assertVoiceSpeedInRange(speed: number): void {
  if (speed < MIN_WHATSAPP_VOICE_SPEED || speed > MAX_WHATSAPP_VOICE_SPEED) {
    throw new Error(
      `WhatsApp voice speed must be between ${MIN_WHATSAPP_VOICE_SPEED} and ${MAX_WHATSAPP_VOICE_SPEED}.`
    );
  }
}

/**
 * Converts a raw provider voice name into UI-friendly copy.
 * @param value - Raw provider voice name
 * @returns Title-cased label
 */
function toTitleCase(value: string): string {
  const trimmedValue = value.trim().toLowerCase();
  if (!trimmedValue) {
    throw new Error("Voice labels must not be empty.");
  }

  return `${trimmedValue.charAt(0).toUpperCase()}${trimmedValue.slice(1)}`;
}

/**
 * Reads a required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
