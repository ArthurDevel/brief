/**
 * Standalone investigation script for WhatsApp voice-option loading.
 *
 * Responsibilities:
 * - Load available voices from the active provider
 * - Normalize the provider response into a WhatsApp DTO
 * - Validate a sample saved voice selection
 * - Write the investigation output to disk
 */

import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVE_VOICE_PROVIDER = "deepgram";
const OUTPUT_FILE_NAME = "voice-options.json";
const DEFAULT_SPEED = 1.2;
const MIN_SPEED = 1.0;
const MAX_SPEED = 1.5;

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppVoiceOption {
  id: string;
  label: string;
  accent: string | null;
  gender: string | null;
  previewUrl: string | null;
  provider: VoiceProviderName;
}

interface WhatsAppVoiceSelection {
  provider: VoiceProviderName;
  voiceId: string;
  speed: number;
}

interface DeepgramModelMetadata {
  accent?: string;
  sample?: string;
  tags?: string[];
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

interface InvestigationOutput {
  provider: VoiceProviderName;
  voiceCount: number;
  validatedSelection: WhatsAppVoiceSelection;
  voices: WhatsAppVoiceOption[];
  generatedAt: string;
}

type VoiceProviderName = "deepgram";

interface VoiceProvider {
  listAvailableVoices(): Promise<WhatsAppVoiceOption[]>;
}

// ============================================================================
// PROVIDERS
// ============================================================================

/**
 * Creates the configured voice provider.
 * @param providerName - The active provider constant
 * @returns Provider implementation
 */
function createVoiceProvider(providerName: VoiceProviderName): VoiceProvider {
  if (providerName === "deepgram") {
    return new DeepgramVoiceProvider();
  }

  throw new Error(`Voice provider "${providerName}" is not implemented.`);
}

class DeepgramVoiceProvider implements VoiceProvider {
  /**
   * Loads available TTS voices from Deepgram and normalizes them.
   * @returns Normalized WhatsApp voice options
   */
  async listAvailableVoices(): Promise<WhatsAppVoiceOption[]> {
    const apiKey = requireEnv("DEEPGRAM_API_KEY");
    const response = await fetch("https://api.deepgram.com/v1/models", {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Deepgram models request failed with ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as DeepgramModelsResponse;
    const rawVoices = Array.isArray(payload.tts) ? payload.tts : [];
    const englishAuraVoices = rawVoices.filter(isSupportedDeepgramVoice);

    return englishAuraVoices
      .map((voice) => ({
        id: voice.canonical_name,
        label: toTitleCase(voice.name),
        accent: normalizeDeepgramAccent(voice.metadata?.accent),
        gender: normalizeDeepgramGender(voice.name),
        previewUrl: voice.metadata?.sample?.trim() || null,
        provider: "deepgram" as const,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Runs the investigation script from start to finish.
 * @returns Promise that resolves when the output file has been written
 */
async function main(): Promise<void> {
  const provider = createVoiceProvider(ACTIVE_VOICE_PROVIDER);
  const voices = await provider.listAvailableVoices();

  if (voices.length === 0) {
    throw new Error(`The ${ACTIVE_VOICE_PROVIDER} provider returned no usable voices.`);
  }

  const sampleSelection: WhatsAppVoiceSelection = {
    provider: ACTIVE_VOICE_PROVIDER,
    voiceId: voices[0].id,
    speed: DEFAULT_SPEED,
  };

  validateVoiceSelection(sampleSelection, voices);

  const output: InvestigationOutput = {
    provider: ACTIVE_VOICE_PROVIDER,
    voiceCount: voices.length,
    validatedSelection: sampleSelection,
    voices,
    generatedAt: new Date().toISOString(),
  };

  const outputPath = await writeOutputFile(output);
  console.info(`[whatsapp-voice-options] wrote ${voices.length} voices to ${outputPath}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[whatsapp-voice-options] ${message}`);
  process.exitCode = 1;
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates a saved selection against the loaded provider catalog.
 * @param selection - Saved voice selection to validate
 * @param voices - Loaded voice options from the provider
 * @returns Nothing. Throws if the selection is invalid.
 */
function validateVoiceSelection(
  selection: WhatsAppVoiceSelection,
  voices: WhatsAppVoiceOption[]
): void {
  if (selection.speed < MIN_SPEED || selection.speed > MAX_SPEED) {
    throw new Error(`Voice speed ${selection.speed} is outside the supported range ${MIN_SPEED}-${MAX_SPEED}.`);
  }

  const matchingVoice = voices.find((voice) => {
    return voice.provider === selection.provider && voice.id === selection.voiceId;
  });

  if (!matchingVoice) {
    throw new Error(
      `Voice "${selection.voiceId}" was not returned by the ${selection.provider} provider.`
    );
  }
}

/**
 * Returns true when a Deepgram model should be exposed to WhatsApp users.
 * @param voice - Deepgram TTS model candidate
 * @returns Whether the model is supported for WhatsApp voice settings
 */
function isSupportedDeepgramVoice(voice: DeepgramModel): boolean {
  const canonicalName = voice.canonical_name.trim();
  const supportsEnglish = voice.languages.some((language) => language.startsWith("en"));
  return canonicalName.startsWith("aura-2-") && supportsEnglish;
}

/**
 * Normalizes the accent field from Deepgram into a readable value.
 * @param accent - Raw accent value from Deepgram
 * @returns Normalized accent, or null when unavailable
 */
function normalizeDeepgramAccent(accent: string | undefined): string | null {
  const normalizedAccent = accent?.trim();
  return normalizedAccent ? normalizedAccent : null;
}

/**
 * Infers a simple gender label from the model name.
 * @param voiceName - Human-readable provider voice name
 * @returns Inferred gender label, or null when unknown
 */
function normalizeDeepgramGender(voiceName: string): string | null {
  const normalizedName = voiceName.trim().toLowerCase();

  if (["andromeda", "delia", "electra", "vesta"].some((name) => normalizedName.includes(name))) {
    return "female";
  }

  if (["mars", "odysseus", "orpheus", "zeus"].some((name) => normalizedName.includes(name))) {
    return "male";
  }

  return null;
}

/**
 * Converts a provider voice name into a UI-friendly label.
 * @param value - Raw provider voice name
 * @returns Title-cased label
 */
function toTitleCase(value: string): string {
  const trimmedValue = value.trim().toLowerCase();
  if (!trimmedValue) {
    throw new Error("Voice label cannot be empty.");
  }

  return trimmedValue.charAt(0).toUpperCase() + trimmedValue.slice(1);
}

/**
 * Writes the investigation output file.
 * @param output - Normalized output payload
 * @returns Absolute output path
 */
async function writeOutputFile(output: InvestigationOutput): Promise<string> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.join(currentDir, "output");
  const outputPath = path.join(outputDir, OUTPUT_FILE_NAME);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  return outputPath;
}

/**
 * Reads a required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to run this investigation.`);
  }

  return value;
}
