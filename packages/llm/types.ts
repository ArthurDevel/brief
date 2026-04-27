/**
 * Shared LLM DTOs and client contracts.
 *
 * Responsibilities:
 * - Define provider-agnostic chat and tool DTOs
 * - Define the text-client interface used by the agent runtimes
 * - Define the provider request config used by the shared fetch client
 */

// ============================================================================
// TYPES
// ============================================================================

export type LlmProvider = "cerebras" | "openrouter";

export interface LlmToolSchemaDto {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
}

export interface LlmToolCallDto {
  arguments: Record<string, unknown>;
  id: string | null;
  name: string;
}

export interface LlmChatMessageDto {
  content: string;
  role: "assistant" | "system" | "tool" | "user";
  toolCallId?: string;
  toolCalls?: LlmToolCallDto[];
}

export interface LlmAssistantMessageDto {
  content: string;
  toolCalls: LlmToolCallDto[];
}

export interface CreateLlmChatCompletionDto {
  messages: LlmChatMessageDto[];
  tools?: LlmToolSchemaDto[];
}

export interface LlmTextClient {
  createChatCompletion(
    input: CreateLlmChatCompletionDto
  ): Promise<LlmAssistantMessageDto>;
}

export interface CreateLlmTextClientDto {
  apiKey: string;
  model: string;
  provider: LlmProvider;
}

export interface LlmProviderRequestConfig {
  headers: Record<string, string>;
  providerLabel: LlmProvider;
  requestLabel: string;
  url: string;
}
