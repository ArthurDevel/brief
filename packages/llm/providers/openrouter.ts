/**
 * OpenRouter request configuration helpers.
 *
 * Responsibilities:
 * - Define the OpenRouter chat-completions endpoint
 * - Build the headers and trace label for OpenRouter requests
 */

import type { LlmProviderRequestConfig } from "../types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// ============================================================================
// MAIN HELPER
// ============================================================================

/**
 * Builds the request config for OpenRouter chat completions.
 * @param apiKey - OpenRouter API key
 * @returns Provider request config
 */
export function createOpenRouterRequestConfig(apiKey: string): LlmProviderRequestConfig {
  return {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    providerLabel: "openrouter",
    requestLabel: "openrouter-chat-completion",
    url: OPENROUTER_CHAT_COMPLETIONS_URL,
  };
}
