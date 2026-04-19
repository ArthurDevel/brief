export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const DEFAULT_VOICE = "aura-2-andromeda-en";
export const DEFAULT_SPEED = 1.2;
export const AGENT_NAME = "voice-review-livekit";
export const DEFAULT_PORT = 8101;

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
export type ConversationMode = "chat" | "demo";

export interface SessionConfig {
  voice: string;
  speed: number;
  mode: ConversationMode;
  demoBrief?: string;
}

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

export function buildGreetingInstructions(config: Pick<SessionConfig, "mode">): string {
  if (config.mode === "demo") {
    return "Open with a short polished demo line, then invite the user to explore the scenario with you.";
  }

  return "Greet the user briefly and invite them to test the voice.";
}
