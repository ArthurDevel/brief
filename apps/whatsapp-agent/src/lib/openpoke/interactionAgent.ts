/**
 * WhatsApp voice interaction agent runtime.
 *
 * Responsibilities:
 * - Run the OpenPokeButVoice interaction loop for one WhatsApp voice turn
 * - Execute interaction tools and aggregate user-visible voice actions
 * - Hand off external work to the execution agent when needed
 */

import { startActiveObservation } from "@langfuse/tracing";
import { createLlmTextClient } from "@dublin/llm/client";
import type {
  LlmChatMessageDto,
  LlmProvider,
  LlmTextClient,
  LlmToolCallDto,
  LlmToolSchemaDto,
} from "@dublin/llm/types";
import {
  buildVoiceOpenPokeConversationStartUserPrompt,
  buildVoiceOpenPokeInteractionSystemPrompt,
  buildVoiceOpenPokeInteractionUserPrompt,
} from "./promptBuilder.js";
import type { VoiceExecutionObserver } from "./narrationTypes.js";
import type {
  ExecuteVoiceAgentRequestDto,
  PreparedVoiceConversationStartDto,
  PreparedVoiceTurnDto,
  RunVoiceInteractionTurnResultDto,
  SupportedConnectorToolkit,
  VoiceUserVisibleActionDto,
} from "./types.js";
import type { VoiceOpenPokeExecutionAgent } from "./executionAgent.js";
import { getLlmApiKey, type AgentEnv } from "../env.js";
import type {
  AppendVoiceInteractionAgentToolResultDto,
  VoiceInteractionAgentStore,
} from "../voiceInteractionAgentStore.js";

// ============================================================================
// TYPES
// ============================================================================

interface ToolExecutionSummary {
  actions: VoiceUserVisibleActionDto[];
  shouldContinue: boolean;
  waitRequested: boolean;
}

export interface SendMessageToAgentArgumentsDto {
  agent_name: string;
  instructions: string;
}

export interface SendMessageToUserArgumentsDto {
  message: string;
}

export interface SendWhatsAppAuthTemplateArgumentsDto {
  toolkit: SupportedConnectorToolkit;
}

export interface SendWhatsAppConnectorOverviewArgumentsDto {}

export interface WaitArgumentsDto {
  reason: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_VOICE_INTERACTION_PROVIDER: LlmProvider = "openrouter";
const WHATSAPP_VOICE_INTERACTION_MODEL = "google/gemini-3-flash-preview";
const MAX_TOOL_ITERATIONS = 8;
const SUPPORTED_CONNECTOR_TOOLKITS = [
  "gmail",
  "googlecalendar",
  "notion",
  "outlook",
] as const;

const INTERACTION_TOOL_SCHEMAS: LlmToolSchemaDto[] = [
  {
    type: "function",
    function: {
      name: "send_message_to_agent",
      description:
        "Run a task through the execution agent. Use this for external app work, lookups, or any task that needs tools.",
      parameters: {
        additionalProperties: false,
        properties: {
          agent_name: {
            description: "Human-readable agent name for this task.",
            type: "string",
          },
          instructions: {
            description: "Clear instructions for the execution agent.",
            type: "string",
          },
        },
        required: ["agent_name", "instructions"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message_to_user",
      description: "Record a plain-text voice message for the user.",
      parameters: {
        additionalProperties: false,
        properties: {
          message: {
            description: "The message to send to the user.",
            type: "string",
          },
        },
        required: ["message"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_whatsapp_auth_template",
      description:
        "Send a WhatsApp connector auth template for Gmail, Google Calendar, Notion, or Outlook.",
      parameters: {
        additionalProperties: false,
        properties: {
          toolkit: {
            description: "The app the user needs to connect.",
            enum: [...SUPPORTED_CONNECTOR_TOOLKITS],
            type: "string",
          },
        },
        required: ["toolkit"],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_whatsapp_connector_overview",
      description: "Send the WhatsApp connector overview template for reconnect and setup flows.",
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait silently to avoid duplicating a user-visible message.",
      parameters: {
        additionalProperties: false,
        properties: {
          reason: {
            description: "Why the runtime should avoid replying again.",
            type: "string",
          },
        },
        required: ["reason"],
        type: "object",
      },
    },
  },
];

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeInteractionAgentRuntime {
  private readonly assistantInstructions: string;
  private readonly executionAgent: VoiceOpenPokeExecutionAgent;
  private readonly llmClient: LlmTextClient;
  private readonly voiceInteractionAgentStore: VoiceInteractionAgentStore | null;

  /**
   * Creates the WhatsApp voice interaction runtime.
   * @param llmClient - LLM client used for interaction planning
   * @param executionAgent - Execution agent used for external tasks
   * @param assistantInstructions - Caller-facing assistant instructions from config
   * @param voiceInteractionAgentStore - Optional voice interaction-agent store for persistence
   */
  constructor(
    llmClient: LlmTextClient,
    executionAgent: VoiceOpenPokeExecutionAgent,
    assistantInstructions = "",
    voiceInteractionAgentStore: VoiceInteractionAgentStore | null = null
  ) {
    this.llmClient = llmClient;
    this.executionAgent = executionAgent;
    this.assistantInstructions = assistantInstructions;
    this.voiceInteractionAgentStore = voiceInteractionAgentStore;
  }

  /**
   * Runs the interaction loop for one prepared voice turn.
   * @param turn - Prepared voice conversation turn
   * @param emitAction - Optional callback for immediate user-visible actions
   * @param executionObserver - Optional observer for delegated execution snapshots
   * @returns User-visible actions produced by the interaction loop
   */
  async runTurn(
    turn: PreparedVoiceTurnDto,
    emitAction?: (action: VoiceUserVisibleActionDto) => Promise<void>,
    executionObserver?: VoiceExecutionObserver
  ): Promise<RunVoiceInteractionTurnResultDto> {
    return await this.runPrompt(
      {
        currentMessageText: turn.currentMessage.text,
        historyCount: turn.conversationHistory.length,
        memoryCount: turn.memoryEntries.length,
        userId: turn.callerContext.supabaseUserId,
      },
      turn,
      buildVoiceOpenPokeInteractionUserPrompt(turn),
      emitAction,
      executionObserver
    );
  }

  /**
   * Runs the initial conversation-start turn before the user says anything.
   * @param turn - Prepared conversation-start context
   * @param emitAction - Optional callback for immediate user-visible actions
   * @param executionObserver - Optional observer for delegated execution snapshots
   * @returns User-visible actions produced by the interaction loop
   */
  async runConversationStart(
    turn: PreparedVoiceConversationStartDto,
    emitAction?: (action: VoiceUserVisibleActionDto) => Promise<void>,
    executionObserver?: VoiceExecutionObserver
  ): Promise<RunVoiceInteractionTurnResultDto> {
    return await this.runPrompt(
      {
        currentMessageText: null,
        historyCount: turn.conversationHistory.length,
        memoryCount: turn.memoryEntries.length,
        userId: turn.callerContext.supabaseUserId,
      },
      turn,
      buildVoiceOpenPokeConversationStartUserPrompt(turn),
      emitAction,
      executionObserver
    );
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Runs one interaction loop from a prepared prompt.
   * @param observationInput - Observation fields for tracing
   * @param turn - Prepared turn context
   * @param userPrompt - Prompt sent as the user message
   * @param emitAction - Optional callback for immediate user-visible actions
   * @param executionObserver - Optional observer for delegated execution snapshots
   * @returns User-visible actions produced by the interaction loop
   */
  private async runPrompt(
    observationInput: {
      currentMessageText: string | null;
      historyCount: number;
      memoryCount: number;
      userId: string;
    },
    turn: PreparedVoiceTurnDto | PreparedVoiceConversationStartDto,
    userPrompt: string,
    emitAction?: (action: VoiceUserVisibleActionDto) => Promise<void>,
    executionObserver?: VoiceExecutionObserver
  ): Promise<RunVoiceInteractionTurnResultDto> {
    return await startActiveObservation(
      "whatsapp-voice-interaction-agent",
      async (agentObservation) => {
        agentObservation.update({
          input: observationInput,
        });

        const messages: LlmChatMessageDto[] = [
          {
            role: "system",
            content: buildVoiceOpenPokeInteractionSystemPrompt(this.assistantInstructions),
          },
          {
            role: "user",
            content: userPrompt,
          },
        ];
        const actions: VoiceUserVisibleActionDto[] = [];
        let waitRequested = false;

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
          const assistantMessage = await this.llmClient.createChatCompletion({
            messages,
            tools: INTERACTION_TOOL_SCHEMAS,
          });

          messages.push({
            content: assistantMessage.content,
            role: "assistant",
            ...(assistantMessage.toolCalls.length > 0
              ? { toolCalls: assistantMessage.toolCalls }
              : {}),
          });

          if (assistantMessage.toolCalls.length === 0) {
            throw new Error("Interaction agent returned plain text without a supported tool call.");
          }

          const toolSummaries: Array<ToolExecutionSummary & { toolResult: string }> = [];
          for (const toolCall of assistantMessage.toolCalls) {
            toolSummaries.push(
              await this.executeToolCall(turn, toolCall, emitAction, executionObserver)
            );
          }

          for (let index = 0; index < assistantMessage.toolCalls.length; index += 1) {
            const toolCall = assistantMessage.toolCalls[index];
            const summary = toolSummaries[index];
            if (!summary) {
              throw new Error(`Missing tool summary for tool call ${toolCall.name}.`);
            }

            actions.push(...summary.actions);
            waitRequested = waitRequested || summary.waitRequested;
            messages.push({
              content: summary.toolResult,
              role: "tool",
              toolCallId: toolCall.id ?? toolCall.name,
            });
          }

          if (!toolSummaries.some((summary) => summary.shouldContinue)) {
            const result = {
              actions,
              status: waitRequested && actions.length === 0 ? "wait" : "completed",
            } satisfies RunVoiceInteractionTurnResultDto;

            agentObservation.update({
              output: {
                actionTypes: result.actions.map((action) => action.type),
                status: result.status,
              },
            });

            return result;
          }
        }

        throw new Error("Interaction agent reached the tool-iteration limit without finishing.");
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
   * Executes one interaction tool call and returns the loop summary.
   * @param turn - Prepared voice turn
   * @param toolCall - Parsed LLM tool call
   * @param emitAction - Optional callback for immediate user-visible actions
   * @param executionObserver - Optional observer for delegated execution snapshots
   * @returns Tool result plus loop metadata
   */
  private async executeToolCall(
    turn: PreparedVoiceTurnDto | PreparedVoiceConversationStartDto,
    toolCall: LlmToolCallDto,
    emitAction?: (action: VoiceUserVisibleActionDto) => Promise<void>,
    executionObserver?: VoiceExecutionObserver
  ): Promise<ToolExecutionSummary & { toolResult: string }> {
    return await startActiveObservation(
      `interaction-tool:${toolCall.name}`,
      async (toolObservation) => {
        const toolCallId = toolCall.id ?? toolCall.name;
        toolObservation.update({
          input: {
            arguments: toolCall.arguments,
            callerPhone: turn.callerContext.callerPhone,
            toolName: toolCall.name,
            userId: turn.callerContext.supabaseUserId,
          },
        });
        await this.appendInteractionAgentToolCall(toolCall.name, toolCall.arguments, toolCallId);

        if (toolCall.name === "send_message_to_agent") {
          const argumentsDto = parseSendMessageToAgentArguments(toolCall.arguments);
          const result = await this.executionAgent.execute({
            agentName: argumentsDto.agent_name,
            callerContext: turn.callerContext,
            instructions: argumentsDto.instructions,
          } satisfies ExecuteVoiceAgentRequestDto, executionObserver);

          const storedToolResult = {
            agent_name: result.agentName,
            response: result.response,
            success: result.success,
          } satisfies Record<string, unknown>;
          const toolResult = JSON.stringify(storedToolResult);
          await this.appendInteractionAgentToolResult({
            toolCallId,
            toolName: toolCall.name,
            toolResult: storedToolResult,
          });

          toolObservation.update({
            output: {
              agentName: result.agentName,
              success: result.success,
              toolResult,
            },
          });

          return {
            actions: [],
            shouldContinue: true,
            toolResult,
            waitRequested: false,
          };
        }

        if (toolCall.name === "send_message_to_user") {
          const argumentsDto = parseSendMessageToUserArguments(toolCall.arguments);
          const action = {
            message: argumentsDto.message,
            type: "message",
          } satisfies VoiceUserVisibleActionDto;
          if (emitAction) {
            await emitAction(action);
          }

          const storedToolResult = {
            message: argumentsDto.message,
            status: "recorded",
          } satisfies Record<string, unknown>;
          const toolResult = JSON.stringify(storedToolResult);
          await this.appendInteractionAgentToolResult({
            toolCallId,
            toolName: toolCall.name,
            toolResult: storedToolResult,
          });

          toolObservation.update({
            output: {
              actionType: action.type,
              toolResult,
            },
          });

          return {
            actions: [action],
            shouldContinue: false,
            toolResult,
            waitRequested: false,
          };
        }

        if (toolCall.name === "send_whatsapp_auth_template") {
          const argumentsDto = parseSendWhatsAppAuthTemplateArguments(toolCall.arguments);
          const action = {
            toolkit: argumentsDto.toolkit,
            type: "auth_template",
          } satisfies VoiceUserVisibleActionDto;
          if (emitAction) {
            await emitAction(action);
          }

          const storedToolResult = {
            status: "auth_template_sent",
            toolkit: argumentsDto.toolkit,
          } satisfies Record<string, unknown>;
          const toolResult = JSON.stringify(storedToolResult);
          await this.appendInteractionAgentToolResult({
            toolCallId,
            toolName: toolCall.name,
            toolResult: storedToolResult,
          });

          toolObservation.update({
            output: {
              actionType: action.type,
              toolResult,
            },
          });

          return {
            actions: [action],
            shouldContinue: true,
            toolResult,
            waitRequested: false,
          };
        }

        if (toolCall.name === "send_whatsapp_connector_overview") {
          parseSendWhatsAppConnectorOverviewArguments(toolCall.arguments);
          const action = {
            type: "connector_overview",
          } satisfies VoiceUserVisibleActionDto;
          if (emitAction) {
            await emitAction(action);
          }

          const storedToolResult = {
            status: "connector_overview_sent",
          } satisfies Record<string, unknown>;
          const toolResult = JSON.stringify(storedToolResult);
          await this.appendInteractionAgentToolResult({
            toolCallId,
            toolName: toolCall.name,
            toolResult: storedToolResult,
          });

          toolObservation.update({
            output: {
              actionType: action.type,
              toolResult,
            },
          });

          return {
            actions: [action],
            shouldContinue: true,
            toolResult,
            waitRequested: false,
          };
        }

        if (toolCall.name === "wait") {
          const argumentsDto = parseWaitArguments(toolCall.arguments);
          const storedToolResult = {
            reason: argumentsDto.reason,
            status: "waiting",
          } satisfies Record<string, unknown>;
          const toolResult = JSON.stringify(storedToolResult);
          await this.appendInteractionAgentToolResult({
            toolCallId,
            toolName: toolCall.name,
            toolResult: storedToolResult,
          });

          toolObservation.update({
            output: {
              toolResult,
            },
          });

          return {
            actions: [],
            shouldContinue: false,
            toolResult,
            waitRequested: true,
          };
        }

        throw new Error(`Unsupported interaction tool: ${toolCall.name}`);
      },
      {
        asType: "tool",
      }
    );
  }

  /**
   * Persists one interaction-agent tool call when the voice interaction store is available.
   * @param toolName - Tool name
   * @param toolArguments - Parsed tool arguments
   * @param toolCallId - Stable tool call ID
   * @returns Nothing
   */
  private async appendInteractionAgentToolCall(
    toolName: string,
    toolArguments: Record<string, unknown>,
    toolCallId: string
  ): Promise<void> {
    if (!this.voiceInteractionAgentStore) {
      return;
    }

    await this.voiceInteractionAgentStore.appendVoiceInteractionAgentToolCall({
      toolArguments,
      toolCallId,
      toolName,
    });
  }

  /**
   * Persists one interaction-agent tool result when the voice interaction store is available.
   * @param input - Stored tool-result DTO
   * @returns Nothing
   */
  private async appendInteractionAgentToolResult(
    input: AppendVoiceInteractionAgentToolResultDto
  ): Promise<void> {
    if (!this.voiceInteractionAgentStore) {
      return;
    }

    await this.voiceInteractionAgentStore.appendVoiceInteractionAgentToolResult(input);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp voice interaction runtime from env.
 * @param env - Agent environment config
 * @param executionAgent - Voice execution agent
 * @returns Ready-to-use interaction runtime
 */
export function createVoiceOpenPokeInteractionAgent(
  env: AgentEnv,
  executionAgent: VoiceOpenPokeExecutionAgent,
  voiceInteractionAgentStore: VoiceInteractionAgentStore | null = null
): VoiceOpenPokeInteractionAgentRuntime {
  return new VoiceOpenPokeInteractionAgentRuntime(
    createLlmTextClient({
      apiKey: getLlmApiKey(WHATSAPP_VOICE_INTERACTION_PROVIDER),
      model: WHATSAPP_VOICE_INTERACTION_MODEL,
      provider: WHATSAPP_VOICE_INTERACTION_PROVIDER,
    }),
    executionAgent,
    env.livekitAgentInstructions,
    voiceInteractionAgentStore
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses and validates one send-message-to-agent argument object.
 * @param value - Raw tool arguments
 * @returns Validated tool arguments
 */
function parseSendMessageToAgentArguments(
  value: Record<string, unknown>
): SendMessageToAgentArgumentsDto {
  const agentName = requireString(value.agent_name, "send_message_to_agent.agent_name");
  const instructions = requireString(value.instructions, "send_message_to_agent.instructions");

  return {
    agent_name: agentName,
    instructions,
  };
}

/**
 * Parses and validates one send-message-to-user argument object.
 * @param value - Raw tool arguments
 * @returns Validated tool arguments
 */
function parseSendMessageToUserArguments(
  value: Record<string, unknown>
): SendMessageToUserArgumentsDto {
  return {
    message: requireString(value.message, "send_message_to_user.message"),
  };
}

/**
 * Parses and validates one wait argument object.
 * @param value - Raw tool arguments
 * @returns Validated tool arguments
 */
function parseWaitArguments(
  value: Record<string, unknown>
): WaitArgumentsDto {
  return {
    reason: requireString(value.reason, "wait.reason"),
  };
}

/**
 * Parses and validates one auth-template argument object.
 * @param value - Raw tool arguments
 * @returns Validated tool arguments
 */
function parseSendWhatsAppAuthTemplateArguments(
  value: Record<string, unknown>
): SendWhatsAppAuthTemplateArgumentsDto {
  return {
    toolkit: requireSupportedConnectorToolkit(value.toolkit, "send_whatsapp_auth_template.toolkit"),
  };
}

/**
 * Parses and validates the connector-overview arguments.
 * @param _value - Raw tool arguments
 * @returns Empty DTO
 */
function parseSendWhatsAppConnectorOverviewArguments(
  _value: Record<string, unknown>
): SendWhatsAppConnectorOverviewArgumentsDto {
  return {};
}

/**
 * Requires one non-empty string value.
 * @param value - Raw input value
 * @param label - Error label
 * @returns Trimmed string value
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Requires one supported connector toolkit slug.
 * @param value - Raw toolkit value
 * @param label - Error label
 * @returns Validated toolkit slug
 */
function requireSupportedConnectorToolkit(
  value: unknown,
  label: string
): SupportedConnectorToolkit {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  if (!SUPPORTED_CONNECTOR_TOOLKITS.includes(value as SupportedConnectorToolkit)) {
    throw new Error(`${label} must be one of ${SUPPORTED_CONNECTOR_TOOLKITS.join(", ")}.`);
  }

  return value as SupportedConnectorToolkit;
}
