/**
 * WhatsApp voice execution agent runtime.
 *
 * Responsibilities:
 * - Run a tool-enabled execution loop with OpenRouter
 * - Create a caller-scoped Composio session for the active call
 * - Execute Composio and WhatsApp auth tools for delegated work
 */

import { Composio } from "@composio/core";
import type { AgentEnv } from "../env.js";
import type { WhatsAppCallerContext } from "../whatsappRuntime.js";
import { createWhatsAppCustomTools } from "../whatsappCustomTools.js";
import {
  FetchOpenRouterTextClient,
  type OpenRouterChatMessageDto,
  type OpenRouterTextClient,
  type OpenRouterToolCallDto,
  type OpenRouterToolSchemaDto,
} from "./openRouterClient.js";
import {
  buildVoiceOpenPokeExecutionFailureSummarizerSystemPrompt,
  buildVoiceOpenPokeExecutionSystemPrompt,
} from "./promptBuilder.js";
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
  toolSchemas: OpenRouterToolSchemaDto[];
}

interface ExecutionTraceEntryDto {
  assistantText: string;
  iteration: number;
  toolArguments: Record<string, unknown>;
  toolName: string;
  toolResult: Record<string, unknown>;
}

export interface VoiceOpenPokeExecutionAgent {
  execute(input: ExecuteVoiceAgentRequestDto): Promise<ExecuteVoiceAgentResultDto>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_VOICE_EXECUTION_MODEL = "google/gemini-3-flash-preview";
const WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_MODEL = "google/gemini-3-flash-preview";
const MAX_TOOL_ITERATIONS = 8;

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeExecutionAgentRuntime implements VoiceOpenPokeExecutionAgent {
  private readonly composioApiKey: string;
  private readonly openRouterClient: OpenRouterTextClient;
  private readonly summarizerClient: OpenRouterTextClient;
  private readonly env: AgentEnv;

  /**
   * Creates the execution runtime for WhatsApp voice tasks.
   * @param openRouterClient - OpenRouter client used for execution planning
   * @param summarizerClient - OpenRouter client used for failed-execution summaries
   * @param composioApiKey - Composio API key for caller-scoped sessions
   * @param env - Agent environment used for WhatsApp auth tools
   */
  constructor(
    openRouterClient: OpenRouterTextClient,
    summarizerClient: OpenRouterTextClient,
    composioApiKey: string,
    env: AgentEnv
  ) {
    this.openRouterClient = openRouterClient;
    this.summarizerClient = summarizerClient;
    this.composioApiKey = composioApiKey;
    this.env = env;
  }

  /**
   * Executes one delegated task for the interaction agent.
   * @param input - Execution request DTO
   * @returns Final execution result for the interaction agent
   */
  async execute(input: ExecuteVoiceAgentRequestDto): Promise<ExecuteVoiceAgentResultDto> {
    const executionTrace: ExecutionTraceEntryDto[] = [];

    try {
      const session = await this.createExecutionSession(input.callerContext);
      const messages: OpenRouterChatMessageDto[] = [
        {
          role: "system",
          content: buildVoiceOpenPokeExecutionSystemPrompt(
            input.agentName,
            session.connectedToolkitSlugs
          ),
        },
        {
          role: "user",
          content: input.instructions,
        },
      ];

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const assistantMessage = await this.openRouterClient.createChatCompletion({
          messages,
          tools: session.toolSchemas,
        });

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

          messages.push({
            content: JSON.stringify(toolResult),
            role: "tool",
            toolCallId: toolCall.id ?? toolCall.name,
          });
        }
      }

      throw new Error("Execution agent reached the tool-iteration limit without a final response.");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const summary = await this.summarizeFailedExecution(input, executionTrace, errorMessage);

      return {
        agentName: input.agentName,
        response: summary,
        success: false,
      };
    }
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
      experimental: {
        customTools: createWhatsAppCustomTools(this.env, callerContext),
      },
      ...(connectedToolkitSlugs.length > 0 ? { toolkits: connectedToolkitSlugs } : {}),
    });
    const sessionTools = await session.tools() as SessionToolDefinition[];
    if (sessionTools.length === 0) {
      throw new Error("Composio did not return any tools for this caller.");
    }

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
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_VOICE_EXECUTION_MODEL,
    }),
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_MODEL,
    }),
    env.composioApiKey,
    env
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
  try {
    const result = await session.executeTool(toolCall.name, toolCall.arguments);
    return {
      arguments: toolCall.arguments,
      result: formatToolResult(toolCall.name, result),
      status: "success",
      tool: toolCall.name,
    };
  } catch (error) {
    return {
      arguments: toolCall.arguments,
      error: error instanceof Error ? error.message : String(error),
      status: "error",
      tool: toolCall.name,
    };
  }
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
