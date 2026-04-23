/**
 * OpenRouter chat client for the WhatsApp text runtimes.
 *
 * Responsibilities:
 * - Send chat-completions requests with optional function tools
 * - Normalize assistant text and tool calls from OpenRouter responses
 * - Keep OpenRouter request/response parsing out of the runtimes
 */

import { startActiveObservation } from "@langfuse/tracing";

// ============================================================================
// TYPES
// ============================================================================

export interface OpenRouterToolSchemaDto {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
}

export interface OpenRouterToolCallDto {
  arguments: Record<string, unknown>;
  id: string | null;
  name: string;
}

export interface OpenRouterChatMessageDto {
  content: string;
  role: "assistant" | "system" | "tool" | "user";
  toolCallId?: string;
  toolCalls?: OpenRouterToolCallDto[];
}

export interface OpenRouterAssistantMessageDto {
  content: string;
  toolCalls: OpenRouterToolCallDto[];
}

export interface CreateOpenRouterChatCompletionDto {
  messages: OpenRouterChatMessageDto[];
  tools?: OpenRouterToolSchemaDto[];
}

interface OpenRouterResponseToolCall {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
}

interface OpenRouterResponseMessage {
  content?: string | Array<{
    text?: string;
    type?: string;
  }>;
  tool_calls?: OpenRouterResponseToolCall[];
}

interface OpenRouterChatCompletionResponse {
  choices?: Array<{
    message?: OpenRouterResponseMessage;
  }>;
  id?: string;
  model?: string;
  usage?: OpenRouterUsage;
}

export interface OpenRouterTextClient {
  createChatCompletion(
    input: CreateOpenRouterChatCompletionDto
  ): Promise<OpenRouterAssistantMessageDto>;
}

interface OpenRouterClientConfig {
  apiKey: string;
  model: string;
}

interface OpenRouterRequestToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id?: string;
  type: "function";
}

interface OpenRouterRequestMessage {
  content: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: OpenRouterRequestToolCall[];
}

interface OpenRouterUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// ============================================================================
// MAIN CLASS
// ============================================================================

export class FetchOpenRouterTextClient implements OpenRouterTextClient {
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * Creates the OpenRouter fetch client.
   * @param config - OpenRouter API config
   */
  constructor(config: OpenRouterClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  /**
   * Requests one assistant step for the supplied messages and tools.
   * @param input - Chat-completion request DTO
   * @returns Assistant message with text and parsed tool calls
   */
  async createChatCompletion(
    input: CreateOpenRouterChatCompletionDto
  ): Promise<OpenRouterAssistantMessageDto> {
    return await startActiveObservation(
      "openrouter-chat-completion",
      async (generation) => {
        generation.update({
          input: {
            messages: input.messages,
            tools: input.tools?.map((tool) => tool.function.name) ?? [],
          },
          metadata: {
            provider: "openrouter",
          },
          model: this.model,
        });

        try {
          const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
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
              statusMessage: "OpenRouter chat completion failed",
            });
            throw new Error(`OpenRouter chat completion failed: ${payload}`);
          }

          const payload = await response.json() as OpenRouterChatCompletionResponse;
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
 * Maps OpenRouter usage fields into Langfuse usage details.
 * @param usage - Usage payload returned by OpenRouter
 * @returns Langfuse-compatible usage details using documented input/output keys
 */
function mapUsageDetails(usage: OpenRouterUsage): Record<string, number> {
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts one local request DTO into the OpenRouter wire format.
 * @param message - Local chat message DTO
 * @returns OpenRouter request message
 */
function mapRequestMessage(message: OpenRouterChatMessageDto): OpenRouterRequestMessage {
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
 * Extracts the assistant text and tool calls from one OpenRouter payload.
 * @param response - Raw OpenRouter response payload
 * @returns Parsed assistant message DTO
 */
function extractAssistantMessage(
  response: OpenRouterChatCompletionResponse
): OpenRouterAssistantMessageDto {
  const message = response.choices?.[0]?.message;
  if (!message) {
    throw new Error("OpenRouter chat completion did not return an assistant message");
  }

  return {
    content: extractAssistantText(message.content),
    toolCalls: extractToolCalls(message.tool_calls),
  };
}

/**
 * Extracts text content from one assistant message payload.
 * @param content - Raw OpenRouter message content
 * @returns Normalized plain-text content
 */
function extractAssistantText(
  content: OpenRouterResponseMessage["content"]
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
 * @param toolCalls - Raw tool call array from OpenRouter
 * @returns Parsed tool-call DTOs
 */
function extractToolCalls(
  toolCalls: OpenRouterResponseToolCall[] | undefined
): OpenRouterToolCallDto[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((toolCall) => {
    const name = toolCall.function?.name?.trim();
    if (!name) {
      throw new Error("OpenRouter returned a tool call without a function name");
    }

    const rawArguments = toolCall.function?.arguments?.trim() ?? "{}";
    const parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
    if (typeof parsedArguments !== "object" || parsedArguments === null || Array.isArray(parsedArguments)) {
      throw new Error(`OpenRouter returned invalid arguments for tool ${name}`);
    }

    return {
      arguments: parsedArguments,
      id: toolCall.id?.trim() || null,
      name,
    };
  });
}
