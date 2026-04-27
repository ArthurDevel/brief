/**
 * WhatsApp voice execution agent runtime.
 *
 * Responsibilities:
 * - Run a tool-enabled execution loop with a provider-backed LLM client
 * - Create a caller-scoped Composio session for the active call
 * - Execute Composio and WhatsApp auth tools for delegated work
 */

import { startActiveObservation } from "@langfuse/tracing";
import { Composio } from "@composio/core";
import { createLlmTextClient } from "@dublin/llm/client";
import {
  createWhatsAppCoreStore,
  fitExecutionHistoryToTokenBudget,
  postProcessExecutionToolResultData,
  type ExecutionAgentMessageDto,
  type ExecutionAgentThreadDto,
  type ExecutionAgentToolCallDto,
  type WhatsAppCoreStore,
} from "@dublin/whatsapp-core";
import type {
  LlmChatMessageDto,
  LlmProvider,
  LlmTextClient,
  LlmToolCallDto,
  LlmToolSchemaDto,
} from "@dublin/llm/types";
import { getLlmApiKey, type AgentEnv } from "../env.js";
import type { WhatsAppCallerContext } from "../whatsappRuntime.js";
import {
  buildVoiceOpenPokeExecutionFailureSummarizerSystemPrompt,
  buildVoiceOpenPokeExecutionSystemPrompt,
} from "./promptBuilder.js";
import type {
  VoiceExecutionObserver,
  VoiceExecutionSnapshotDto,
  VoiceExecutionStatus,
} from "./narrationTypes.js";
import type {
  ExecuteVoiceAgentRequestDto,
  ExecuteVoiceAgentResultDto,
} from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

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
  toolSchemas: LlmToolSchemaDto[];
}

interface ExecutionTraceEntryDto {
  assistantText: string;
  iteration: number;
  toolArguments: Record<string, unknown>;
  toolName: string;
  toolResult: Record<string, unknown>;
}

export interface VoiceOpenPokeExecutionAgent {
  execute(
    input: ExecuteVoiceAgentRequestDto,
    executionObserver?: VoiceExecutionObserver
  ): Promise<ExecuteVoiceAgentResultDto>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_VOICE_EXECUTION_PROVIDER: LlmProvider = "cerebras";
const WHATSAPP_VOICE_EXECUTION_MODEL = "zai-glm-4.7";
const WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_PROVIDER: LlmProvider = "openrouter";
const WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_MODEL = "google/gemini-3-flash-preview";
const MAX_PERSISTED_EXECUTION_MESSAGES = 20;
const MAX_EXECUTION_PROMPT_TOKENS = 130000;
const MAX_TOOL_ITERATIONS = 8;

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeExecutionAgentRuntime implements VoiceOpenPokeExecutionAgent {
  private readonly composioApiKey: string;
  private readonly llmClient: LlmTextClient;
  private readonly summarizerClient: LlmTextClient;
  private readonly whatsappCoreStore: WhatsAppCoreStore;

  /**
   * Creates the execution runtime for WhatsApp voice tasks.
   * @param llmClient - LLM client used for execution planning
   * @param summarizerClient - LLM client used for failed-execution summaries
   * @param whatsappCoreStore - Shared store used for persisted execution threads
   * @param composioApiKey - Composio API key for caller-scoped sessions
   */
  constructor(
    llmClient: LlmTextClient,
    summarizerClient: LlmTextClient,
    whatsappCoreStore: WhatsAppCoreStore,
    composioApiKey: string
  ) {
    this.llmClient = llmClient;
    this.summarizerClient = summarizerClient;
    this.whatsappCoreStore = whatsappCoreStore;
    this.composioApiKey = composioApiKey;
  }

  /**
   * Executes one delegated task for the interaction agent.
   * @param input - Execution request DTO
   * @param executionObserver - Optional observer for read-only execution snapshots
   * @returns Final execution result for the interaction agent
   */
  async execute(
    input: ExecuteVoiceAgentRequestDto,
    executionObserver?: VoiceExecutionObserver
  ): Promise<ExecuteVoiceAgentResultDto> {
    return await startActiveObservation(
      `execution-agent:${input.agentName}`,
      async (agentObservation) => {
        const executionTrace: ExecutionTraceEntryDto[] = [];
        const executionStartedAt = new Date().toISOString();
        const executionId = `${input.agentName}:${Date.now()}`;
        let thread: ExecutionAgentThreadDto | null = null;

        agentObservation.update({
          input: {
            agentName: input.agentName,
            callerPhone: input.callerContext.callerPhone,
            instructions: input.instructions,
            userId: input.callerContext.supabaseUserId,
          },
        });

        try {
          await notifyExecutionObserver(
            executionObserver,
            buildExecutionSnapshot({
              currentToolName: null,
              executionId,
              executionTrace,
              input,
              latestAssistantText: null,
              startedAt: executionStartedAt,
              status: "starting",
            })
          );

          thread = await this.whatsappCoreStore.findOrCreateExecutionAgentThread({
            agentName: input.agentName,
            userId: input.callerContext.supabaseUserId,
          });
          const persistedMessages = await this.whatsappCoreStore.listExecutionAgentMessages({
            limit: MAX_PERSISTED_EXECUTION_MESSAGES,
            threadId: thread.id,
            userId: input.callerContext.supabaseUserId,
          });
          const session = await this.createExecutionSession(input.callerContext);
          const systemMessage = buildVoiceOpenPokeExecutionSystemPrompt(
            input.agentName,
            session.connectedToolkitSlugs
          );
          const replaySafePersistedMessages = fitExecutionHistoryToTokenBudget({
            maxPromptTokens: MAX_EXECUTION_PROMPT_TOKENS,
            persistedMessages,
            systemMessage,
            toolSchemas: session.toolSchemas,
            userMessage: input.instructions,
          });
          if (replaySafePersistedMessages.length < persistedMessages.length) {
            console.info("[whatsapp-agent] trimmed persisted execution history for prompt budget", {
              agentName: input.agentName,
              originalMessageCount: persistedMessages.length,
              retainedMessageCount: replaySafePersistedMessages.length,
            });
          }
          const messages: LlmChatMessageDto[] = [
            {
              role: "system",
              content: systemMessage,
            },
            ...replaySafePersistedMessages.map(mapPersistedExecutionMessageToLlmMessage),
            {
              role: "user",
              content: input.instructions,
            },
          ];
          await this.whatsappCoreStore.appendExecutionAgentMessage({
            content: input.instructions,
            role: "user",
            threadId: thread.id,
            userId: input.callerContext.supabaseUserId,
          });

          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
            const assistantMessage = await this.llmClient.createChatCompletion({
              messages,
              tools: session.toolSchemas,
            });

            await notifyExecutionObserver(
              executionObserver,
              buildExecutionSnapshot({
                currentToolName: null,
                executionId,
                executionTrace,
                input,
                latestAssistantText: assistantMessage.content,
                startedAt: executionStartedAt,
                status: "planning",
              })
            );

            messages.push({
              content: assistantMessage.content,
              role: "assistant",
              ...(assistantMessage.toolCalls.length > 0
                ? { toolCalls: assistantMessage.toolCalls }
                : {}),
            });

            if (assistantMessage.toolCalls.length === 0) {
              if (!assistantMessage.content.trim()) {
                throw new Error("Execution agent returned neither a tool call nor a final response.");
              }

              await this.whatsappCoreStore.appendExecutionAgentMessage({
                content: assistantMessage.content,
                role: "assistant",
                threadId: thread.id,
                userId: input.callerContext.supabaseUserId,
              });

              agentObservation.update({
                output: {
                  response: assistantMessage.content.trim(),
                  success: true,
                },
              });

              await notifyExecutionObserver(
                executionObserver,
                buildExecutionSnapshot({
                  currentToolName: null,
                  executionId,
                  executionTrace,
                  input,
                  latestAssistantText: assistantMessage.content,
                  startedAt: executionStartedAt,
                  status: "finished",
                })
              );

              return {
                agentName: input.agentName,
                response: assistantMessage.content.trim(),
                success: true,
              };
            }

            await this.whatsappCoreStore.appendExecutionAgentToolCall({
              content: assistantMessage.content,
              threadId: thread.id,
              toolCalls: assistantMessage.toolCalls.map((toolCall) => ({
                arguments: toolCall.arguments,
                id: toolCall.id,
                name: toolCall.name,
              })),
              userId: input.callerContext.supabaseUserId,
            });

            for (const toolCall of assistantMessage.toolCalls) {
              await notifyExecutionObserver(
                executionObserver,
                buildExecutionSnapshot({
                  currentToolName: toolCall.name,
                  executionId,
                  executionTrace,
                  input,
                  latestAssistantText: assistantMessage.content,
                  startedAt: executionStartedAt,
                  status: "running_tool",
                })
              );

              const toolResult = await executeToolCall(session, toolCall);
              executionTrace.push({
                assistantText: assistantMessage.content,
                iteration: iteration + 1,
                toolArguments: toolCall.arguments,
                toolName: toolCall.name,
                toolResult,
              });

              await notifyExecutionObserver(
                executionObserver,
                buildExecutionSnapshot({
                  currentToolName: toolCall.name,
                  executionId,
                  executionTrace,
                  input,
                  latestAssistantText: assistantMessage.content,
                  startedAt: executionStartedAt,
                  status: "running_tool",
                })
              );

              messages.push({
                content: JSON.stringify(toolResult),
                role: "tool",
                toolCallId: toolCall.id ?? toolCall.name,
              });
              await this.whatsappCoreStore.appendExecutionAgentToolResult({
                content: JSON.stringify(toolResult),
                threadId: thread.id,
                toolArguments: toolCall.arguments,
                toolCallId: toolCall.id ?? toolCall.name,
                toolName: toolCall.name,
                toolResult,
                userId: input.callerContext.supabaseUserId,
              });
            }
          }

          throw new Error("Execution agent reached the tool-iteration limit without a final response.");
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const summary = await this.summarizeFailedExecution(input, executionTrace, errorMessage);

          if (thread) {
            await this.whatsappCoreStore.appendExecutionAgentMessage({
              content: summary,
              role: "assistant",
              threadId: thread.id,
              userId: input.callerContext.supabaseUserId,
            });
          }

          agentObservation.update({
            level: "ERROR",
            output: {
              response: summary,
              success: false,
            },
            statusMessage: errorMessage,
          });

          await notifyExecutionObserver(
            executionObserver,
            buildExecutionSnapshot({
              currentToolName: executionTrace.at(-1)?.toolName ?? null,
              executionId,
              executionTrace,
              input,
              latestAssistantText: summary,
              startedAt: executionStartedAt,
              status: "failed",
            })
          );

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

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Creates one caller-scoped Composio session and tool registry.
   * @param callerContext - Caller-scoped runtime context
   * @returns Execution session with schemas and executor
   */
  private async createExecutionSession(
    callerContext: WhatsAppCallerContext
  ): Promise<ComposioExecutionSession> {
    return await startActiveObservation(
      "create-execution-session",
      async (sessionObservation) => {
        sessionObservation.update({
          input: {
            callerPhone: callerContext.callerPhone,
            connectedToolkitSlugs: Object.keys(callerContext.connectedAccountsByToolkit),
            userId: callerContext.supabaseUserId,
          },
        });

        const composio = new Composio({
          apiKey: this.composioApiKey,
        });
        const connectedToolkitSlugs = Object.keys(callerContext.connectedAccountsByToolkit);
        const session = await composio.create(callerContext.supabaseUserId, {
          manageConnections: false,
          workbench: {
            enable: false,
          },
          connectedAccounts: callerContext.connectedAccountsByToolkit,
          ...(connectedToolkitSlugs.length > 0 ? { toolkits: connectedToolkitSlugs } : {}),
        });
        const sessionTools = await session.tools() as SessionToolDefinition[];
        if (sessionTools.length === 0) {
          throw new Error("Composio did not return any tools for this caller.");
        }

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
          toolSchemas: mapSessionToolsToLlmSchemas(sessionTools),
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
    input: ExecuteVoiceAgentRequestDto,
    executionTrace: ExecutionTraceEntryDto[],
    errorMessage: string
  ): Promise<string> {
    try {
      const summaryMessage = await this.summarizerClient.createChatCompletion({
        messages: [
          {
            role: "system",
            content: buildVoiceOpenPokeExecutionFailureSummarizerSystemPrompt(input.agentName),
          },
          {
            role: "user",
            content: buildFailedExecutionSummaryPrompt(input, executionTrace, errorMessage),
          },
        ],
      });

      const summary = summaryMessage.content.trim();
      if (!summary) {
        throw new Error("Execution failure summarizer returned an empty summary.");
      }

      return summary;
    } catch {
      return buildLocalExecutionFailureSummary(executionTrace, errorMessage);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp voice execution runtime from env.
 * @param env - Agent environment config
 * @returns Ready-to-use execution runtime
 */
export function createVoiceOpenPokeExecutionAgent(
  env: AgentEnv
): VoiceOpenPokeExecutionAgentRuntime {
  return new VoiceOpenPokeExecutionAgentRuntime(
    createLlmTextClient({
      apiKey: getLlmApiKey(WHATSAPP_VOICE_EXECUTION_PROVIDER),
      model: WHATSAPP_VOICE_EXECUTION_MODEL,
      provider: WHATSAPP_VOICE_EXECUTION_PROVIDER,
    }),
    createLlmTextClient({
      apiKey: getLlmApiKey(WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_PROVIDER),
      model: WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_MODEL,
      provider: WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_PROVIDER,
    }),
    createWhatsAppCoreStore({
      supabaseServiceRoleKey: env.supabaseServiceRoleKey,
      supabaseUrl: env.supabaseUrl,
    }),
    env.composioApiKey
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Notifies the execution observer with one read-only execution snapshot.
 * @param executionObserver - Optional observer callback
 * @param snapshot - Snapshot to publish
 * @returns Nothing
 */
async function notifyExecutionObserver(
  executionObserver: VoiceExecutionObserver | undefined,
  snapshot: VoiceExecutionSnapshotDto
): Promise<void> {
  if (!executionObserver) {
    return;
  }

  await executionObserver.onExecutionSnapshot(snapshot);
}

/**
 * Maps one persisted execution-agent row into the LLM message format.
 * @param message - Persisted execution-agent message
 * @returns LLM chat message DTO
 */
function mapPersistedExecutionMessageToLlmMessage(
  message: ExecutionAgentMessageDto
): LlmChatMessageDto {
  if (message.role === "assistant") {
    return {
      content: message.content,
      role: "assistant",
      ...(message.toolCalls && message.toolCalls.length > 0
        ? { toolCalls: message.toolCalls.map(mapPersistedExecutionToolCall) }
        : {}),
    };
  }

  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new Error("Persisted execution tool message is missing toolCallId.");
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
 * Maps one persisted execution-agent tool call into the LLM format.
 * @param toolCall - Persisted execution-agent tool call
 * @returns LLM tool call DTO
 */
function mapPersistedExecutionToolCall(
  toolCall: ExecutionAgentToolCallDto
): LlmToolCallDto {
  return {
    arguments: toolCall.arguments,
    id: toolCall.id,
    name: toolCall.name,
  };
}

/**
 * Builds a read-only execution snapshot for the narration flow.
 * @param input - Snapshot builder inputs
 * @returns Execution snapshot DTO
 */
function buildExecutionSnapshot(input: {
  currentToolName: string | null;
  executionId: string;
  executionTrace: ExecutionTraceEntryDto[];
  input: ExecuteVoiceAgentRequestDto;
  latestAssistantText: string | null;
  startedAt: string;
  status: VoiceExecutionStatus;
}): VoiceExecutionSnapshotDto {
  const recentMessages = buildRecentExecutionMessages(
    input.executionTrace,
    input.latestAssistantText
  );

  return {
    agentName: input.input.agentName,
    currentToolName: input.currentToolName,
    executionId: input.executionId,
    instructions: input.input.instructions,
    recentMessages,
    startedAt: input.startedAt,
    status: input.status,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Builds the recent execution-context lines exposed to the narrator.
 * @param executionTrace - Recent execution trace entries
 * @param latestAssistantText - Latest execution-agent assistant text
 * @returns Recent execution context lines
 */
function buildRecentExecutionMessages(
  executionTrace: ExecutionTraceEntryDto[],
  latestAssistantText: string | null
): string[] {
  const recentTraceLines = executionTrace
    .slice(-4)
    .flatMap((entry) => {
      const status = typeof entry.toolResult.status === "string"
        ? entry.toolResult.status
        : "unknown";

      return [
        entry.assistantText.trim()
          ? `Execution thought: ${entry.assistantText.trim()}`
          : null,
        `Tool ${entry.toolName} finished with status ${status}.`,
      ].filter((value): value is string => Boolean(value));
    });

  const assistantLine = latestAssistantText?.trim()
    ? [`Latest execution note: ${latestAssistantText.trim()}`]
    : [];

  return [...recentTraceLines, ...assistantLine].slice(-5);
}

/**
 * Executes one session-backed tool call and normalizes the tool payload.
 * @param session - Active Composio execution session
 * @param toolCall - Parsed LLM tool call
 * @returns Structured tool result for the execution loop
 */
async function executeToolCall(
  session: ComposioExecutionSession,
  toolCall: LlmToolCallDto
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
        const result = await session.executeTool(toolCall.name, toolCall.arguments);
        const formattedResult = {
          arguments: toolCall.arguments,
          result: formatToolResult(toolCall.name, toolCall.arguments, result),
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
 * Maps Composio session tools into LLM function schemas.
 * @param sessionTools - Tool definitions returned by Composio
 * @returns LLM-compatible function schemas
 */
function mapSessionToolsToLlmSchemas(
  sessionTools: SessionToolDefinition[]
): LlmToolSchemaDto[] {
  return sessionTools.map((tool) => {
    const name = tool.function?.name?.trim();
    if (!name) {
      throw new Error("Composio returned a tool without a function name.");
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
 * @param toolArguments - Tool arguments used for execution
 * @param result - Raw tool result
 * @returns Structured tool result
 */
function formatToolResult(
  toolName: string,
  toolArguments: Record<string, unknown>,
  result: unknown
): unknown {
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
      data: postProcessExecutionToolResultData({
        toolArguments,
        toolName,
        toolResultData: typedResult.data,
      }),
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
  input: ExecuteVoiceAgentRequestDto,
  executionTrace: ExecutionTraceEntryDto[],
  errorMessage: string
): string {
  return [
    `Agent name: ${input.agentName}`,
    `Caller phone: ${input.callerContext.callerPhone}`,
    `Original instructions:\n${input.instructions}`,
    `Final error:\n${errorMessage}`,
    "Execution trace:",
    executionTrace.length > 0
      ? executionTrace
          .map((entry) => [
            `Iteration ${entry.iteration}`,
            `Assistant text: ${entry.assistantText || "(empty)"}`,
            `Tool: ${entry.toolName}`,
            `Arguments: ${JSON.stringify(entry.toolArguments)}`,
            `Result: ${JSON.stringify(entry.toolResult)}`,
          ].join("\n"))
          .join("\n\n")
      : "No tool calls were completed before the failure.",
  ].join("\n\n");
}

/**
 * Returns a simple local fallback summary when the summarizer also fails.
 * @param executionTrace - Recent execution trace entries
 * @param errorMessage - Final failure message
 * @returns Concise fallback summary
 */
function buildLocalExecutionFailureSummary(
  executionTrace: ExecutionTraceEntryDto[],
  errorMessage: string
): string {
  const lastEntry = executionTrace.at(-1);

  if (!lastEntry) {
    return `The execution agent could not start the task. Final error: ${errorMessage}`;
  }

  return [
    `The execution agent did not finish the task.`,
    `Latest tool: ${lastEntry.toolName}.`,
    `Latest result: ${JSON.stringify(lastEntry.toolResult)}.`,
    `Final error: ${errorMessage}`,
  ].join(" ");
}
