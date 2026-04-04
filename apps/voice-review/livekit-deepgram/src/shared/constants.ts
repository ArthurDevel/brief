export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const DEFAULT_VOICE = "aura-2-andromeda-en";
export const DEFAULT_SPEED = 1.2;
export const AGENT_NAME = "voice-review-livekit";
export const DEFAULT_PORT = 8101;

export const SYSTEM_PROMPT =
  "You are a friendly voice assistant used for testing voice quality. " +
  "Have a casual, natural conversation. Keep responses concise (1-3 sentences). " +
  "You can talk about anything -- weather, hobbies, travel, food, tech, etc. " +
  "Be warm and conversational, as if chatting with a friend.";

export const AVAILABLE_VOICES = [
  { id: "aura-2-andromeda-en", name: "Andromeda", accent: "American", gender: "Female" },
  { id: "aura-2-delia-en", name: "Delia", accent: "British", gender: "Female" },
  { id: "aura-2-electra-en", name: "Electra", accent: "American", gender: "Female" },
  { id: "aura-2-vesta-en", name: "Vesta", accent: "American", gender: "Female" },
  { id: "aura-2-mars-en", name: "Mars", accent: "American", gender: "Male" },
  { id: "aura-2-odysseus-en", name: "Odysseus", accent: "British", gender: "Male" },
  { id: "aura-2-orpheus-en", name: "Orpheus", accent: "American", gender: "Male" },
  { id: "aura-2-zeus-en", name: "Zeus", accent: "American", gender: "Male" }
] as const;

export type VoiceOption = (typeof AVAILABLE_VOICES)[number];

export interface SessionConfig {
  voice: string;
  speed: number;
}
