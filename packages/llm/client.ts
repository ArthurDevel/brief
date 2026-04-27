/**
 * Shared fetch-based LLM client factory.
 *
 * Responsibilities:
 * - Create one provider-backed text client from simple config
 * - Normalize request and response payloads for tool-calling chat completions
 * - Keep provider-specific HTTP details out of the agent runtimes
 */

import { startActiveObservation } from "@langfuse/tracing";
import { createCerebrasRequestConfig } from "./providers/cerebras.js";
import { createOpenRouterRequestConfig } from "./providers/openrouter.js";
import type {
  CreateLlmChatCompletionDto,
  CreateLlmTextClientDto,
  LlmAssistantMessageDto,
  LlmChatMessageDto,
  LlmProviderRequestConfig,
  LlmTextClient,
  LlmToolCallDto,
} from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

interface LlmResponseToolCall {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
}

interface LlmResponseMessage {
  content?: string | Array<{
    text?: string;
    type?: string;
  }>;
  tool_calls?: LlmResponseToolCall[];
}

interface LlmChatCompletionResponse {
  choices?: Array<{
    message?: LlmResponseMessage;
  }>;
  id?: string;
  model?: string;
  usage?: LlmUsage;
}

interface LlmRequestToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id?: string;
  type: "function";
}

interface LlmRequestMessage {
  content: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: LlmRequestToolCall[];
}

interface LlmUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

// ============================================================================
// MAIN FACTORY
// ============================================================================

/**
 * Creates one provider-backed LLM text client.
 * @param input - Provider, model, and API key
 * @returns Provider-backed text client
 */
export function createLlmTextClient(input: CreateLlmTextClientDto): LlmTextClient {
  const providerConfig = createProviderRequestConfig(input);

  return new FetchLlmTextClient(providerConfig, input.model);
}

// ============================================================================
// MAIN CLASS
// ============================================================================

class FetchLlmTextClient implements LlmTextClient {
  private readonly model: string;
  private readonly providerConfig: LlmProviderRequestConfig;

  /**
   * Creates one fetch-backed LLM text client.
   * @param providerConfig - Provider-specific request config
   * @param model - Provider model name
   */
  constructor(providerConfig: LlmProviderRequestConfig, model: string) {
    this.providerConfig = providerConfig;
    this.model = model;
  }

  /**
   * Requests one assistant step for the supplied messages and tools.
   * @param input - Chat-completion request DTO
   * @returns Assistant message with text and parsed tool calls
   */
  async createChatCompletion(
    input: CreateLlmChatCompletionDto
  ): Promise<LlmAssistantMessageDto> {
    return await startActiveObservation(
      this.providerConfig.requestLabel,
      async (generation) => {
        generation.update({
          input: {
            messages: input.messages,
            tools: input.tools?.map((tool) => tool.function.name) ?? [],
          },
          metadata: {
            provider: this.providerConfig.providerLabel,
          },
          model: this.model,
        });

        try {
          const response = await fetch(this.providerConfig.url, {
            method: "POST",
            headers: this.providerConfig.headers,
            body: JSON.stringify({
              messages: input.messages.map((message) => mapRequestMessage(message)),
              model: this.model,
              ...(input.tools ? { tools: input.tools } : {}),
            }),
            cache: "no-store",
          });

          if (!response.ok) {
            const payload = await response.text();
            generation.update({
              level: "ERROR",
              output: {
                error: payload,
              },
              statusMessage: `${this.providerConfig.providerLabel} chat completion failed`,
            });
            throw new Error(`${this.providerConfig.providerLabel} chat completion failed: ${payload}`);
          }

          const payload = await response.json() as LlmChatCompletionResponse;
          const assistantMessage = extractAssistantMessage(payload);

          generation.update({
            model: typeof payload.model === "string" ? payload.model : this.model,
            output: {
              content: assistantMessage.content,
              responseId: payload.id ?? null,
              toolCalls: assistantMessage.toolCalls,
            },
            ...(payload.usage
              ? {
                  usageDetails: mapUsageDetails(payload.usage),
                }
              : {}),
          });

          return assistantMessage;
        } catch (error) {
          generation.update({
            level: "ERROR",
            statusMessage: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      {
        asType: "generation",
      }
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates the provider-specific request config.
 * @param input - Provider selection and credentials
 * @returns Provider request config
 */
function createProviderRequestConfig(
  input: CreateLlmTextClientDto
): LlmProviderRequestConfig {
  if (input.provider === "openrouter") {
    return createOpenRouterRequestConfig(input.apiKey);
  }

  if (input.provider === "cerebras") {
    return createCerebrasRequestConfig(input.apiKey);
  }

  throw new Error(`LLM provider "${input.provider}" is not implemented.`);
}

/**
 * Maps usage fields into Langfuse usage details.
 * @param usage - Usage payload returned by the provider
 * @returns Langfuse-compatible usage details
 */
function mapUsageDetails(usage: LlmUsage): Record<string, number> {
  const usageDetails: Record<string, number> = {};

  if (typeof usage.prompt_tokens === "number") {
    usageDetails.input = usage.prompt_tokens;
  }

  if (typeof usage.completion_tokens === "number") {
    usageDetails.output = usage.completion_tokens;
  }

  if (typeof usage.total_tokens === "number") {
    usageDetails.total = usage.total_tokens;
  }

  if (typeof usage.reasoning_tokens === "number") {
    usageDetails.output_reasoning_tokens = usage.reasoning_tokens;
  }

  return usageDetails;
}

/**
 * Converts one local request DTO into the provider wire format.
 * @param message - Local chat message DTO
 * @returns Provider request message
 */
function mapRequestMessage(message: LlmChatMessageDto): LlmRequestMessage {
  return {
    content: message.content,
    role: message.role,
    ...(message.role === "assistant" && message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            function: {
              arguments: JSON.stringify(toolCall.arguments),
              name: toolCall.name,
            },
            ...(toolCall.id ? { id: toolCall.id } : {}),
            type: "function" as const,
          })),
        }
      : {}),
    ...(message.role === "tool" && message.toolCallId
      ? { tool_call_id: message.toolCallId }
      : {}),
  };
}

/**
 * Extracts the assistant text and tool calls from one provider payload.
 * @param response - Raw chat-completion response payload
 * @returns Parsed assistant message DTO
 */
function extractAssistantMessage(
  response: LlmChatCompletionResponse
): LlmAssistantMessageDto {
  const message = response.choices?.[0]?.message;
  if (!message) {
    throw new Error("Chat completion did not return an assistant message.");
  }

  return {
    content: extractAssistantText(message.content),
    toolCalls: extractToolCalls(message.tool_calls),
  };
}

/**
 * Extracts text content from one assistant message payload.
 * @param content - Raw message content
 * @returns Normalized plain-text content
 */
function extractAssistantText(
  content: LlmResponseMessage["content"]
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Extracts and validates tool calls from one assistant message.
 * @param toolCalls - Raw tool calls from the provider
 * @returns Parsed tool-call DTOs
 */
function extractToolCalls(
  toolCalls: LlmResponseToolCall[] | undefined
): LlmToolCallDto[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((toolCall) => {
    const name = toolCall.function?.name?.trim();
    if (!name) {
      throw new Error("The provider returned a tool call without a function name.");
    }

    const rawArguments = toolCall.function?.arguments?.trim() ?? "{}";
    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(rawArguments);
    } catch (error) {
      throw new Error(
        `The provider returned invalid JSON arguments for tool ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
      throw new Error(`The provider returned non-object tool arguments for tool ${name}.`);
    }

    return {
      arguments: parsedArguments as Record<string, unknown>,
      id: toolCall.id?.trim() || null,
      name,
    };
  });
}
