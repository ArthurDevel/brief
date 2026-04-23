/**
 * WhatsApp text execution agent runtime.
 *
 * Responsibilities:
 * - Run a tool-enabled execution loop with OpenRouter
 * - Reload persisted execution history for one user + agent thread
 * - Create a user-scoped Composio session for the linked WhatsApp user
 * - Execute Composio and WhatsApp auth tools for one interaction turn
 */

import { startActiveObservation } from "@langfuse/tracing";
import { Composio } from "@composio/core";
import {
  createWhatsAppCoreStore,
  type ExecutionAgentMessageDto,
  type ExecutionAgentThreadDto,
  type StoreExecutionAgentMessageDto,
  type WhatsAppCoreStore,
  type WhatsAppLinkedUserDto,
} from "@dublin/whatsapp-core";
import { getWhatsAppTextAgentEnv } from "./env.js";
import {
  FetchOpenRouterTextClient,
  type OpenRouterChatMessageDto,
  type OpenRouterTextClient,
  type OpenRouterToolCallDto,
  type OpenRouterToolSchemaDto,
} from "./openRouterClient.js";
import {
  buildWhatsAppExecutionFailureSummarizerSystemPrompt,
  buildWhatsAppExecutionSystemPrompt,
} from "./promptBuilder.js";
import type {
  ExecuteAgentRequestDto,
  ExecuteAgentResultDto,
} from "./types.js";
import { createWhatsAppTextCustomTools } from "./whatsappTextCustomTools.js";

// ============================================================================
// TYPES
// ============================================================================

interface ComposioConnectedAccountRow {
  id: string;
  status: "ACTIVE" | "EXPIRED" | "FAILED" | "INACTIVE" | "INITIATED";
  toolkit: {
    slug: string;
  };
  updatedAt: string;
}

interface SessionToolDefinition {
  function?: {
    description?: string | null;
    name?: string | null;
    parameters?: unknown;
  };
  type?: string;
}

interface ToolExecutionResult {
  data?: unknown;
  error?: unknown;
  logId?: string;
}

interface ComposioExecutionSession {
  connectedToolkitSlugs: string[];
  executeTool: (
    toolName: string,
    toolArguments: Record<string, unknown>
  ) => Promise<unknown>;
  toolSchemas: OpenRouterToolSchemaDto[];
}

interface ExecutionTraceEntryDto {
  assistantText: string;
  iteration: number;
  toolArguments: Record<string, unknown>;
  toolName: string;
  toolResult: Record<string, unknown>;
}

export interface WhatsAppTextExecutionAgent {
  execute(input: ExecuteAgentRequestDto): Promise<ExecuteAgentResultDto>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_TEXT_EXECUTION_MODEL = "google/gemini-3-flash-preview";
const WHATSAPP_TEXT_EXECUTION_FAILURE_SUMMARIZER_MODEL = "google/gemini-3-flash-preview";
const MAX_PERSISTED_EXECUTION_MESSAGES = 20;
const MAX_TOOL_ITERATIONS = 8;

// ============================================================================
// MAIN CLASS
// ============================================================================

export class WhatsAppTextExecutionAgentRuntime implements WhatsAppTextExecutionAgent {
  private readonly composioApiKey: string;
  private readonly openRouterClient: OpenRouterTextClient;
  private readonly summarizerClient: OpenRouterTextClient;
  private readonly whatsappCoreStore: WhatsAppCoreStore;
  private readonly whatsappAccessToken: string;
  private readonly whatsappApiVersion: string;
  private readonly whatsappPhoneNumberId: string;

  /**
   * Creates the execution runtime for WhatsApp text tasks.
   * @param openRouterClient - OpenRouter client used for execution planning
   * @param summarizerClient - OpenRouter client used for failed-execution summaries
   * @param whatsappCoreStore - Shared store used for persisted execution threads
   * @param composioApiKey - Composio API key for user-scoped sessions
   * @param whatsappAccessToken - Meta Graph access token for auth tools
   * @param whatsappApiVersion - Meta Graph API version
   * @param whatsappPhoneNumberId - Sending phone number ID for auth tools
   */
  constructor(
    openRouterClient: OpenRouterTextClient,
    summarizerClient: OpenRouterTextClient,
    whatsappCoreStore: WhatsAppCoreStore,
    composioApiKey: string,
    whatsappAccessToken: string,
    whatsappApiVersion: string,
    whatsappPhoneNumberId: string
  ) {
    this.openRouterClient = openRouterClient;
    this.summarizerClient = summarizerClient;
    this.whatsappCoreStore = whatsappCoreStore;
    this.composioApiKey = composioApiKey;
    this.whatsappAccessToken = whatsappAccessToken;
    this.whatsappApiVersion = whatsappApiVersion;
    this.whatsappPhoneNumberId = whatsappPhoneNumberId;
  }

  /**
   * Executes one interaction-agent request with Composio-backed tools.
   * @param input - Execution request DTO
   * @returns Final execution result for the interaction agent
   */
  async execute(input: ExecuteAgentRequestDto): Promise<ExecuteAgentResultDto> {
    return await startActiveObservation(
      `execution-agent:${input.agentName}`,
      async (agentObservation) => {
        const startedAt = Date.now();
        const executionTrace: ExecutionTraceEntryDto[] = [];
        let thread: ExecutionAgentThreadDto | null = null;
        console.info("[whatsapp-server] execution agent started", {
          agentName: input.agentName,
          instructionLength: input.instructions.length,
          userId: input.linkedUser.userId,
          whatsappPhone: input.linkedUser.whatsappPhone,
        });

        agentObservation.update({
          input: {
            agentName: input.agentName,
            instructions: input.instructions,
          },
        });

        try {
          thread = await this.whatsappCoreStore.findOrCreateExecutionAgentThread({
            agentName: input.agentName,
            userId: input.linkedUser.userId,
          });
          const persistedMessages = await this.whatsappCoreStore.listExecutionAgentMessages({
            limit: MAX_PERSISTED_EXECUTION_MESSAGES,
            threadId: thread.id,
            userId: input.linkedUser.userId,
          });
          const session = await this.createExecutionSession(input.linkedUser);
          const messages: OpenRouterChatMessageDto[] = [
            {
              role: "system",
              content: buildWhatsAppExecutionSystemPrompt(
                input.agentName,
                session.connectedToolkitSlugs
              ),
            },
            ...persistedMessages.map(mapPersistedExecutionMessageToOpenRouterMessage),
            {
              role: "user",
              content: input.instructions,
            },
          ];
          await this.appendThreadMessages(thread.id, input.linkedUser.userId, [
            buildUserExecutionAgentMessage(input.instructions),
          ]);

          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
            console.info("[whatsapp-server] execution iteration requesting LLM step", {
              agentName: input.agentName,
              iteration: iteration + 1,
              messageCount: messages.length,
              toolCount: session.toolSchemas.length,
            });

            const assistantMessage = await this.openRouterClient.createChatCompletion({
              messages,
              tools: session.toolSchemas,
            });

            console.info("[whatsapp-server] execution iteration received LLM step", {
              agentName: input.agentName,
              assistantTextLength: assistantMessage.content.length,
              iteration: iteration + 1,
              toolCallCount: assistantMessage.toolCalls.length,
              toolNames: assistantMessage.toolCalls.map((toolCall) => toolCall.name),
            });

            messages.push({
              content: assistantMessage.content,
              role: "assistant",
              ...(assistantMessage.toolCalls.length > 0
                ? { toolCalls: assistantMessage.toolCalls }
                : {}),
            });
            await this.appendThreadMessages(thread.id, input.linkedUser.userId, [
              buildAssistantExecutionAgentMessage(assistantMessage),
            ]);

            if (assistantMessage.toolCalls.length === 0) {
              if (!assistantMessage.content.trim()) {
                throw new Error("Execution agent returned neither a tool call nor a final response");
              }

              console.info("[whatsapp-server] execution agent completed", {
                agentName: input.agentName,
                durationMs: Date.now() - startedAt,
                responseLength: assistantMessage.content.trim().length,
                success: true,
              });

              agentObservation.update({
                output: {
                  response: assistantMessage.content.trim(),
                  success: true,
                },
              });

              return {
                agentName: input.agentName,
                response: assistantMessage.content.trim(),
                success: true,
              };
            }

            for (const toolCall of assistantMessage.toolCalls) {
              const toolResult = await executeToolCall(session, toolCall);
              executionTrace.push({
                assistantText: assistantMessage.content,
                iteration: iteration + 1,
                toolArguments: toolCall.arguments,
                toolName: toolCall.name,
                toolResult,
              });
              console.info("[whatsapp-server] execution tool completed", {
                agentName: input.agentName,
                status: toolResult.status,
                toolName: toolCall.name,
              });
              const toolCallId = toolCall.id ?? toolCall.name;
              const toolMessageContent = JSON.stringify(toolResult);
              messages.push({
                content: toolMessageContent,
                role: "tool",
                toolCallId,
              });
              await this.appendThreadMessages(thread.id, input.linkedUser.userId, [
                buildToolExecutionAgentMessage(toolCall, toolCallId, toolMessageContent, toolResult),
              ]);
            }
          }

          throw new Error("Execution agent reached the tool-iteration limit without a final response");
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error("[whatsapp-server] execution agent failed", {
            agentName: input.agentName,
            error: errorMessage,
            traceEntryCount: executionTrace.length,
          });

          const summary = await this.summarizeFailedExecution(input, executionTrace, errorMessage);
          if (thread) {
            await this.appendThreadMessages(thread.id, input.linkedUser.userId, [
              buildUserFacingExecutionFailureMessage(summary),
            ]);
          }
          console.info("[whatsapp-server] execution agent returned failure summary", {
            agentName: input.agentName,
            durationMs: Date.now() - startedAt,
            responseLength: summary.length,
          });

          agentObservation.update({
            level: "ERROR",
            output: {
              response: summary,
              success: false,
            },
            statusMessage: errorMessage,
          });

          return {
            agentName: input.agentName,
            response: summary,
            success: false,
          };
        }
      },
      {
        asType: "agent",
      }
    );
  }

  /**
   * Persists one or more execution-agent messages and updates the thread timestamp.
   * @param threadId - Persisted execution-agent thread ID
   * @param userId - Supabase user ID that owns the thread
   * @param messages - Execution-agent messages to append
   * @returns Promise that resolves when the messages are stored
   */
  private async appendThreadMessages(
    threadId: string,
    userId: string,
    messages: StoreExecutionAgentMessageDto[]
  ): Promise<void> {
    await this.whatsappCoreStore.storeExecutionAgentMessages({
      messages,
      threadId,
      userId,
    });
    await this.whatsappCoreStore.touchExecutionAgentThread({
      threadId,
      userId,
    });
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Creates one user-scoped Composio session and tool registry.
   * @param linkedUser - Linked WhatsApp user
   * @returns Execution session with schemas and executor
   */
  private async createExecutionSession(
    linkedUser: WhatsAppLinkedUserDto
  ): Promise<ComposioExecutionSession> {
    return await startActiveObservation(
      "create-execution-session",
      async (sessionObservation) => {
        const startedAt = Date.now();
        console.info("[whatsapp-server] creating execution session", {
          userId: linkedUser.userId,
          whatsappPhone: linkedUser.whatsappPhone,
        });

        sessionObservation.update({
          input: {
            userId: linkedUser.userId,
          },
        });

        const composio = new Composio({
          apiKey: this.composioApiKey,
        });
        const connectedAccounts = await composio.connectedAccounts.list({
          userIds: [linkedUser.userId],
          limit: 100,
        });
        const connectedAccountsByToolkit = buildConnectedAccountsByToolkit(
          Array.isArray(connectedAccounts.items)
            ? connectedAccounts.items as ComposioConnectedAccountRow[]
            : []
        );
        const connectedToolkitSlugs = Object.keys(connectedAccountsByToolkit);
        console.info("[whatsapp-server] loaded connected accounts for execution session", {
          connectedToolkitSlugs,
          userId: linkedUser.userId,
        });

        const session = await composio.create(linkedUser.userId, {
          manageConnections: false,
          workbench: {
            enable: false,
          },
          connectedAccounts: connectedAccountsByToolkit,
          experimental: {
            customTools: createWhatsAppTextCustomTools(
              {
                accessToken: this.whatsappAccessToken,
                apiVersion: this.whatsappApiVersion,
                phoneNumberId: this.whatsappPhoneNumberId,
              },
              linkedUser.whatsappPhone
            ),
          },
          ...(connectedToolkitSlugs.length > 0 ? { toolkits: connectedToolkitSlugs } : {}),
        });
        const sessionTools = await session.tools() as SessionToolDefinition[];
        if (sessionTools.length === 0) {
          throw new Error("Composio did not return any tools for this WhatsApp user");
        }

        console.info("[whatsapp-server] created execution session", {
          connectedToolkitSlugs,
          durationMs: Date.now() - startedAt,
          toolCount: sessionTools.length,
          userId: linkedUser.userId,
        });

        sessionObservation.update({
          output: {
            connectedToolkitSlugs,
            toolCount: sessionTools.length,
          },
        });

        return {
          connectedToolkitSlugs,
          executeTool: async (
            toolName: string,
            toolArguments: Record<string, unknown>
          ): Promise<unknown> => {
            if (toolName.startsWith("COMPOSIO_")) {
              return composio.tools.executeMetaTool(toolName, {
                arguments: toolArguments,
                sessionId: session.sessionId,
              });
            }

            return session.execute(toolName, toolArguments);
          },
          toolSchemas: mapSessionToolsToOpenRouterSchemas(sessionTools),
        };
      }
    );
  }

  /**
   * Summarizes a failed execution attempt for the interaction agent.
   * @param input - Original execution request DTO
   * @param executionTrace - Recent execution trace entries
   * @param errorMessage - Final failure message
   * @returns Concise failure summary for the interaction agent
   */
  private async summarizeFailedExecution(
    input: ExecuteAgentRequestDto,
    executionTrace: ExecutionTraceEntryDto[],
    errorMessage: string
  ): Promise<string> {
    console.info("[whatsapp-server] summarizing failed execution", {
      agentName: input.agentName,
      error: errorMessage,
      traceEntryCount: executionTrace.length,
    });

    try {
      const summaryMessage = await this.summarizerClient.createChatCompletion({
        messages: [
          {
            role: "system",
            content: buildWhatsAppExecutionFailureSummarizerSystemPrompt(input.agentName),
          },
          {
            role: "user",
            content: buildFailedExecutionSummaryPrompt(input, executionTrace, errorMessage),
          },
        ],
      });

      const summary = summaryMessage.content.trim();
      if (!summary) {
        throw new Error("Execution failure summarizer returned an empty summary");
      }

      return summary;
    } catch (error) {
      const summarizerError = error instanceof Error ? error.message : String(error);
      console.error("[whatsapp-server] failed to summarize execution failure", {
        agentName: input.agentName,
        error: summarizerError,
      });

      return buildLocalExecutionFailureSummary(executionTrace, errorMessage);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp text execution runtime from env.
 * @returns Ready-to-use execution runtime
 */
export function createWhatsAppTextExecutionAgent(): WhatsAppTextExecutionAgentRuntime {
  const env = getWhatsAppTextAgentEnv();

  return new WhatsAppTextExecutionAgentRuntime(
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_TEXT_EXECUTION_MODEL,
    }),
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_TEXT_EXECUTION_FAILURE_SUMMARIZER_MODEL,
    }),
    createWhatsAppCoreStore({
      supabaseServiceRoleKey: env.supabaseServiceRoleKey,
      supabaseUrl: env.supabaseUrl,
    }),
    env.composioApiKey,
    env.whatsappAccessToken,
    env.whatsappApiVersion,
    env.whatsappPhoneNumberId
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Executes one session-backed tool call and normalizes the tool payload.
 * @param session - Active Composio execution session
 * @param toolCall - Parsed OpenRouter tool call
 * @returns Structured tool result for the execution loop
 */
async function executeToolCall(
  session: ComposioExecutionSession,
  toolCall: OpenRouterToolCallDto
): Promise<Record<string, unknown>> {
  return await startActiveObservation(
    `execution-tool:${toolCall.name}`,
    async (toolObservation) => {
      toolObservation.update({
        input: {
          arguments: toolCall.arguments,
          toolName: toolCall.name,
        },
      });

      try {
        console.info("[whatsapp-server] executing Composio tool", {
          argumentKeys: Object.keys(toolCall.arguments),
          toolName: toolCall.name,
        });
        const result = await session.executeTool(toolCall.name, toolCall.arguments);
        const formattedResult = {
          arguments: toolCall.arguments,
          result: formatToolResult(toolCall.name, result),
          status: "success",
          tool: toolCall.name,
        };

        toolObservation.update({
          output: formattedResult,
        });

        return formattedResult;
      } catch (error) {
        const failedResult = {
          arguments: toolCall.arguments,
          error: error instanceof Error ? error.message : String(error),
          status: "error",
          tool: toolCall.name,
        };

        console.error("[whatsapp-server] Composio tool failed", {
          error: failedResult.error,
          toolName: toolCall.name,
        });

        toolObservation.update({
          level: "ERROR",
          output: failedResult,
          statusMessage: failedResult.error,
        });

        return failedResult;
      }
    },
    {
      asType: "tool",
    }
  );
}

/**
 * Maps one persisted execution-agent row back into an OpenRouter chat message.
 * @param message - Persisted execution-agent message DTO
 * @returns OpenRouter chat message DTO
 */
function mapPersistedExecutionMessageToOpenRouterMessage(
  message: ExecutionAgentMessageDto
): OpenRouterChatMessageDto {
  if (message.role === "assistant") {
    return {
      content: message.content,
      role: "assistant",
      ...(message.toolCalls && message.toolCalls.length > 0
        ? { toolCalls: message.toolCalls }
        : {}),
    };
  }

  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new Error("Persisted execution tool message is missing toolCallId");
    }

    return {
      content: message.content,
      role: "tool",
      toolCallId: message.toolCallId,
    };
  }

  return {
    content: message.content,
    role: "user",
  };
}

/**
 * Builds one persisted user row for an execution-agent instruction.
 * @param content - Execution instruction content
 * @returns Persisted execution-agent message DTO
 */
function buildUserExecutionAgentMessage(content: string): StoreExecutionAgentMessageDto {
  return {
    content,
    role: "user",
    toolArguments: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
    toolResult: null,
  };
}

/**
 * Builds one persisted assistant row for an OpenRouter execution step.
 * @param assistantMessage - Assistant step returned by OpenRouter
 * @returns Persisted execution-agent message DTO
 */
function buildAssistantExecutionAgentMessage(
  assistantMessage: {
    content: string;
    toolCalls: OpenRouterToolCallDto[];
  }
): StoreExecutionAgentMessageDto {
  return {
    content: assistantMessage.content,
    role: "assistant",
    toolArguments: null,
    toolCallId: null,
    toolCalls: assistantMessage.toolCalls.map((toolCall) => ({
      arguments: toolCall.arguments,
      id: toolCall.id,
      name: toolCall.name,
    })),
    toolName: null,
    toolResult: null,
  };
}

/**
 * Builds one persisted tool row for a completed execution tool call.
 * @param toolCall - Tool call requested by the assistant
 * @param toolCallId - Stable tool call ID used in the chat history
 * @param content - Serialized tool result content
 * @param toolResult - Structured tool result payload
 * @returns Persisted execution-agent message DTO
 */
function buildToolExecutionAgentMessage(
  toolCall: OpenRouterToolCallDto,
  toolCallId: string,
  content: string,
  toolResult: Record<string, unknown>
): StoreExecutionAgentMessageDto {
  return {
    content,
    role: "tool",
    toolArguments: toolCall.arguments,
    toolCallId,
    toolCalls: null,
    toolName: toolCall.name,
    toolResult,
  };
}

/**
 * Builds one persisted assistant row for a failure summary returned to the interaction agent.
 * @param content - Failure summary content
 * @returns Persisted execution-agent message DTO
 */
function buildUserFacingExecutionFailureMessage(content: string): StoreExecutionAgentMessageDto {
  return {
    content,
    role: "assistant",
    toolArguments: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
    toolResult: null,
  };
}

/**
 * Keeps only the latest active connected account per toolkit.
 * @param connections - Connected-account rows returned by Composio
 * @returns Connected account IDs keyed by toolkit slug
 */
function buildConnectedAccountsByToolkit(
  connections: ComposioConnectedAccountRow[]
): Record<string, string> {
  const connectedAccountsByToolkit: Record<string, string> = {};
  const latestUpdatedAtByToolkit = new Map<string, number>();

  for (const connection of connections) {
    const toolkit = connection.toolkit.slug.trim().toLowerCase();
    if (!toolkit || connection.status !== "ACTIVE") {
      continue;
    }

    const updatedAt = new Date(connection.updatedAt).getTime();
    const latestUpdatedAt = latestUpdatedAtByToolkit.get(toolkit) ?? Number.NEGATIVE_INFINITY;

    if (updatedAt >= latestUpdatedAt) {
      connectedAccountsByToolkit[toolkit] = connection.id;
      latestUpdatedAtByToolkit.set(toolkit, updatedAt);
    }
  }

  return connectedAccountsByToolkit;
}

/**
 * Maps Composio session tools into OpenRouter function schemas.
 * @param sessionTools - Tool definitions returned by Composio
 * @returns OpenRouter-compatible function schemas
 */
function mapSessionToolsToOpenRouterSchemas(
  sessionTools: SessionToolDefinition[]
): OpenRouterToolSchemaDto[] {
  return sessionTools.map((tool) => {
    const name = tool.function?.name?.trim();
    if (!name) {
      throw new Error("Composio returned a tool without a function name");
    }

    return {
      function: {
        description: tool.function?.description?.trim() || `Execute the tool ${name}.`,
        name,
        parameters: normalizeParametersSchema(tool.function?.parameters),
      },
      type: "function",
    };
  });
}

/**
 * Normalizes one session tool parameter schema.
 * @param parameters - Raw parameters definition from Composio
 * @returns JSON schema object
 */
function normalizeParametersSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }

  return {
    additionalProperties: true,
    properties: {},
    type: "object",
  };
}

/**
 * Normalizes tool execution payloads across Composio response shapes.
 * @param toolName - Tool name used for execution
 * @param result - Raw tool result
 * @returns Structured tool result
 */
function formatToolResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const typedResult = result as ToolExecutionResult;
  if (typedResult.error) {
    throw new Error(
      typeof typedResult.error === "string"
        ? typedResult.error
        : JSON.stringify(typedResult.error)
    );
  }

  if (Object.prototype.hasOwnProperty.call(typedResult, "data")) {
    return {
      data: typedResult.data,
      logId: typedResult.logId ?? null,
      tool: toolName,
    };
  }

  return typedResult;
}

/**
 * Builds the failed-execution prompt sent to the summarizer model.
 * @param input - Original execution request DTO
 * @param executionTrace - Recent execution trace entries
 * @param errorMessage - Final failure message
 * @returns Prompt content for the summarizer model
 */
function buildFailedExecutionSummaryPrompt(
  input: ExecuteAgentRequestDto,
  executionTrace: ExecutionTraceEntryDto[],
  errorMessage: string
): string {
  return [
    `<agent_name>${input.agentName}</agent_name>`,
    `<original_instructions>\n${input.instructions}\n</original_instructions>`,
    `<failure>\n${errorMessage}\n</failure>`,
    `<execution_trace>\n${JSON.stringify(executionTrace, null, 2)}\n</execution_trace>`,
  ].join("\n\n");
}

/**
 * Builds a local fallback summary when the summarizer model also fails.
 * @param executionTrace - Recent execution trace entries
 * @param errorMessage - Final failure message
 * @returns Concise fallback summary
 */
function buildLocalExecutionFailureSummary(
  executionTrace: ExecutionTraceEntryDto[],
  errorMessage: string
): string {
  const lastTools = executionTrace
    .slice(-3)
    .map((entry) => entry.toolName)
    .join(", ");

  if (!lastTools) {
    return `The execution run failed before it produced a final result. Failure: ${errorMessage}`;
  }

  return `The execution run failed after repeated tool activity. Last tools used: ${lastTools}. Failure: ${errorMessage}`;
}
