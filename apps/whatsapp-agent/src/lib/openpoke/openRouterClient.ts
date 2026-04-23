/**
 * OpenRouter chat client for the WhatsApp voice OpenPoke runtimes.
 *
 * Responsibilities:
 * - Send chat-completions requests with optional function tools
 * - Normalize assistant text and tool calls from OpenRouter responses
 * - Keep OpenRouter request and response parsing out of the runtimes
 */

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
      throw new Error(`OpenRouter chat completion failed: ${payload}`);
    }

    const payload = await response.json() as OpenRouterChatCompletionResponse;
    return extractAssistantMessage(payload);
  }
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
    throw new Error("OpenRouter response did not include a message.");
  }

  const content = extractAssistantContent(message.content);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((toolCall) => parseToolCall(toolCall))
    : [];

  return {
    content,
    toolCalls,
  };
}

/**
 * Normalizes assistant content into one plain string.
 * @param content - Raw OpenRouter message content
 * @returns Plain assistant text
 */
function extractAssistantContent(
  content: OpenRouterResponseMessage["content"]
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

/**
 * Parses one raw tool call from OpenRouter.
 * @param toolCall - Raw OpenRouter tool call
 * @returns Normalized tool call DTO
 */
function parseToolCall(toolCall: OpenRouterResponseToolCall): OpenRouterToolCallDto {
  const name = toolCall.function?.name?.trim();
  if (!name) {
    throw new Error("OpenRouter returned a tool call without a function name.");
  }

  const argumentsJson = toolCall.function?.arguments ?? "{}";
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch (error) {
    throw new Error(
      `OpenRouter returned invalid JSON arguments for tool ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
    throw new Error(`OpenRouter returned non-object tool arguments for tool ${name}.`);
  }

  return {
    arguments: parsedArguments as Record<string, unknown>,
    id: typeof toolCall.id === "string" ? toolCall.id : null,
    name,
  };
}
