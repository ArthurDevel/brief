/**
 * Text-only narration runtime for WhatsApp voice execution waits.
 *
 * Responsibilities:
 * - Convert recent execution context into one short filler sentence
 * - Keep narration separate from the interaction and execution runtimes
 * - Return text only and leave TTS ownership to the voice runtime
 */

import type { AgentEnv } from "../env.js";
import {
  FetchOpenRouterTextClient,
  type OpenRouterChatMessageDto,
  type OpenRouterTextClient,
} from "./openRouterClient.js";
import type {
  VoiceNarrationRequestDto,
  VoiceNarrationResultDto,
  VoiceOpenPokeNarrationAgent,
} from "./narrationTypes.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_VOICE_NARRATION_MODEL = "google/gemini-3-flash-preview";
const MAX_RECENT_MESSAGES = 5;
const MAX_NARRATION_LENGTH = 120;
const SKIP_SENTINEL = "SKIP";

const WHATSAPP_VOICE_NARRATION_SYSTEM_PROMPT = [
  "You are the narrator agent for a WhatsApp voice assistant.",
  "You read recent execution context and write one short filler sentence for the user.",
  "Keep it to one natural sentence.",
  "Present tense only.",
  "Do not claim the task is finished.",
  "Do not mention internal agents, prompts, traces, or hidden reasoning.",
  "Generic progress language is acceptable when the context is vague.",
  `If no narration is useful, return exactly ${SKIP_SENTINEL}.`,
].join("\n\n");

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeNarrationAgentRuntime implements VoiceOpenPokeNarrationAgent {
  private readonly openRouterClient: OpenRouterTextClient;

  /**
   * Creates the narration runtime for WhatsApp voice waits.
   * @param openRouterClient - OpenRouter client used for narration generation
   */
  constructor(openRouterClient: OpenRouterTextClient) {
    this.openRouterClient = openRouterClient;
  }

  /**
   * Generates one short narration sentence from recent execution context.
   * @param input - Narration request DTO
   * @returns One short narration sentence, or null when narration should be skipped
   */
  async generateNarration(
    input: VoiceNarrationRequestDto
  ): Promise<VoiceNarrationResultDto | null> {
    const assistantMessage = await this.openRouterClient.createChatCompletion({
      messages: buildNarrationMessages(input),
    });
    const message = normalizeNarrationMessage(assistantMessage.content);
    if (!message) {
      return null;
    }

    return {
      createdAt: new Date().toISOString(),
      message,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp voice narration runtime from env.
 * @param env - Agent environment config
 * @returns Ready-to-use narration runtime
 */
export function createVoiceOpenPokeNarrationAgent(
  env: AgentEnv
): VoiceOpenPokeNarrationAgentRuntime {
  return new VoiceOpenPokeNarrationAgentRuntime(
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_VOICE_NARRATION_MODEL,
    })
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the narrator prompt messages for one active execution.
 * @param input - Narration request DTO
 * @returns Chat-completion messages for the narrator
 */
function buildNarrationMessages(
  input: VoiceNarrationRequestDto
): OpenRouterChatMessageDto[] {
  const recentMessages = input.activeExecution.recentMessages
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => `- ${message}`)
    .join("\n");

  return [
    {
      role: "system",
      content: WHATSAPP_VOICE_NARRATION_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        `Agent name: ${input.activeExecution.agentName}`,
        `Execution status: ${input.activeExecution.status}`,
        `Current tool: ${input.activeExecution.currentToolName ?? "None"}`,
        `Original instructions:\n${input.activeExecution.instructions}`,
        `Recent execution context:\n${recentMessages || "- None"}`,
        `Previous narration:\n${input.previousNarration ?? "None"}`,
      ].join("\n\n"),
    },
  ];
}

/**
 * Normalizes one raw narration response into a short sentence.
 * @param value - Raw model output
 * @returns Clean narration sentence, or null when narration should be skipped
 */
function normalizeNarrationMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === SKIP_SENTINEL) {
    return null;
  }

  const singleLine = trimmed.replace(/\s+/g, " ");
  const firstSentence = extractFirstSentence(singleLine);
  const normalized = firstSentence.length > MAX_NARRATION_LENGTH
    ? `${firstSentence.slice(0, MAX_NARRATION_LENGTH - 1).trimEnd()}...`
    : firstSentence;

  return normalized.trim() || null;
}

/**
 * Extracts the first sentence-like segment from one model response.
 * @param value - Raw normalized output
 * @returns First sentence-like segment
 */
function extractFirstSentence(value: string): string {
  const sentenceMatch = value.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) {
    return sentenceMatch[1];
  }

  return value;
}
