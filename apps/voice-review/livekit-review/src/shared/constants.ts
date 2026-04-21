/**
 * Shared configuration for the LiveKit voice review app.
 *
 * Responsibilities:
 * - Define the supported STT and TTS providers
 * - Expose the available TTS voices and defaults
 * - Provide the shared session config used by the server, client, and worker
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const DEFAULT_SPEED = 1.2;
export const AGENT_NAME = "livekit-review";
export const DEFAULT_PORT = 8101;

const DEFAULT_TTS_PROVIDER = "deepgram";
const DEFAULT_STT_PROVIDER = "deepgram";

const CHAT_SYSTEM_PROMPT =
  "You are a friendly voice assistant used for testing voice quality. " +
  "Have a casual, natural conversation. Keep responses concise (1-3 sentences). " +
  "You can talk about anything -- weather, hobbies, travel, food, tech, etc. " +
  "Be warm and conversational, as if chatting with a friend. " +
  "At the start of the conversation, greet the user briefly and invite them to test the voice. " +
  "Do not mention system prompts, hidden instructions, tools, or function calls.";

const DEMO_SYSTEM_PROMPT =
  "You are a friendly voice assistant used for recording short qualitative voice demos. " +
  "This is a conversation-only experience, not a tool-using workflow. " +
  "Do not mention tools, APIs, function calls, system prompts, or hidden instructions. " +
  "Keep responses concise (1-3 sentences), natural, and polished. " +
  "Be proactive and specific so the conversation produces memorable demo audio. " +
  "At the start of the conversation, open with a short demo-ready introduction and smoothly introduce one concrete scenario. " +
  "If the user gives little direction, lead gently instead of stalling. " +
  "Prefer vivid, tangible examples over generic small talk, but do not sound scripted.";

// ============================================================================
// TYPES
// ============================================================================

export type TtsProviderName = "deepgram" | "xai";
export type SttProviderName = "deepgram" | "xai";
export type ConversationMode = "chat" | "demo";

export interface ProviderOption<TProvider extends string> {
  id: TProvider;
  label: string;
}

export interface VoiceOption {
  id: string;
  provider: TtsProviderName;
  name: string;
  accent: string | null;
  gender: string | null;
}

export interface SessionConfig {
  ttsProvider: TtsProviderName;
  sttProvider: SttProviderName;
  voice: string;
  speed: number;
  mode: ConversationMode;
  demoBrief?: string;
}

// ============================================================================
// PROVIDERS
// ============================================================================

export const AVAILABLE_TTS_PROVIDERS: ProviderOption<TtsProviderName>[] = [
  { id: "deepgram", label: "Deepgram" },
  { id: "xai", label: "xAI" },
];

export const AVAILABLE_STT_PROVIDERS: ProviderOption<SttProviderName>[] = [
  { id: "deepgram", label: "Deepgram" },
  { id: "xai", label: "xAI" },
];

export const AVAILABLE_VOICES: VoiceOption[] = [
  { id: "aura-2-andromeda-en", provider: "deepgram", name: "Andromeda", accent: "American", gender: "Female" },
  { id: "aura-2-delia-en", provider: "deepgram", name: "Delia", accent: "British", gender: "Female" },
  { id: "aura-2-electra-en", provider: "deepgram", name: "Electra", accent: "American", gender: "Female" },
  { id: "aura-2-vesta-en", provider: "deepgram", name: "Vesta", accent: "American", gender: "Female" },
  { id: "aura-2-mars-en", provider: "deepgram", name: "Mars", accent: "American", gender: "Male" },
  { id: "aura-2-odysseus-en", provider: "deepgram", name: "Odysseus", accent: "British", gender: "Male" },
  { id: "aura-2-orpheus-en", provider: "deepgram", name: "Orpheus", accent: "American", gender: "Male" },
  { id: "aura-2-zeus-en", provider: "deepgram", name: "Zeus", accent: "American", gender: "Male" },
  { id: "ara", provider: "xai", name: "Ara", accent: null, gender: null },
  { id: "eve", provider: "xai", name: "Eve", accent: null, gender: null },
  { id: "leo", provider: "xai", name: "Leo", accent: null, gender: null },
  { id: "rex", provider: "xai", name: "Rex", accent: null, gender: null },
  { id: "sal", provider: "xai", name: "Sal", accent: null, gender: null },
];

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the default TTS provider.
 * @returns Default TTS provider name
 */
export function getDefaultTtsProvider(): TtsProviderName {
  return DEFAULT_TTS_PROVIDER;
}

/**
 * Returns the default STT provider.
 * @returns Default STT provider name
 */
export function getDefaultSttProvider(): SttProviderName {
  return DEFAULT_STT_PROVIDER;
}

/**
 * Returns the default voice for a TTS provider.
 * @param provider - Selected TTS provider
 * @returns Provider-specific default voice ID
 */
export function getDefaultVoice(provider: TtsProviderName): string {
  if (provider === "xai") {
    return "eve";
  }

  return "aura-2-andromeda-en";
}

/**
 * Returns the available voices for one provider.
 * @param provider - Selected TTS provider
 * @returns Provider-specific voice list
 */
export function getVoicesForProvider(provider: TtsProviderName): VoiceOption[] {
  return AVAILABLE_VOICES.filter((voice) => {
    return voice.provider === provider;
  });
}

/**
 * Returns true when the provider value is supported.
 * @param value - Raw provider value
 * @returns Whether the TTS provider is known
 */
export function isTtsProvider(value: string): value is TtsProviderName {
  return AVAILABLE_TTS_PROVIDERS.some((provider) => provider.id === value);
}

/**
 * Returns true when the provider value is supported.
 * @param value - Raw provider value
 * @returns Whether the STT provider is known
 */
export function isSttProvider(value: string): value is SttProviderName {
  return AVAILABLE_STT_PROVIDERS.some((provider) => provider.id === value);
}

/**
 * Returns true when a voice belongs to the selected provider.
 * @param provider - Selected TTS provider
 * @param voiceId - Candidate voice ID
 * @returns Whether the voice is valid for the provider
 */
export function isVoiceSupported(provider: TtsProviderName, voiceId: string): boolean {
  return AVAILABLE_VOICES.some((voice) => {
    return voice.provider === provider && voice.id === voiceId;
  });
}

/**
 * Builds the system prompt for the selected conversation mode.
 * @param config - Session config subset used by the prompt
 * @returns System prompt text
 */
export function buildSystemPrompt(config: Pick<SessionConfig, "mode" | "demoBrief">): string {
  if (config.mode !== "demo") {
    return CHAT_SYSTEM_PROMPT;
  }

  const demoBrief = config.demoBrief?.trim();
  if (!demoBrief) {
    return DEMO_SYSTEM_PROMPT;
  }

  return [
    DEMO_SYSTEM_PROMPT,
    "Demo brief:",
    demoBrief,
    "Use the demo brief as product direction for what to naturally surface in the conversation. " +
      "Do not recite it mechanically unless the wording fits organically."
  ].join("\n\n");
}

/**
 * Builds the first-turn instructions for the selected conversation mode.
 * @param config - Session config subset used by the greeting
 * @returns Greeting instructions for the agent
 */
export function buildGreetingInstructions(config: Pick<SessionConfig, "mode">): string {
  if (config.mode === "demo") {
    return "Open with a short polished demo line, then invite the user to explore the scenario with you.";
  }

  return "Greet the user briefly and invite them to test the voice.";
}
