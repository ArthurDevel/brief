/**
 * Cerebras request configuration helpers.
 *
 * Responsibilities:
 * - Define the Cerebras chat-completions endpoint
 * - Build the headers and trace label for Cerebras requests
 */

import type { LlmProviderRequestConfig } from "../types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions";

// ============================================================================
// MAIN HELPER
// ============================================================================

/**
 * Builds the request config for Cerebras chat completions.
 * @param apiKey - Cerebras API key
 * @returns Provider request config
 */
export function createCerebrasRequestConfig(apiKey: string): LlmProviderRequestConfig {
  return {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    providerLabel: "cerebras",
    requestLabel: "cerebras-chat-completion",
    url: CEREBRAS_CHAT_COMPLETIONS_URL,
  };
}
