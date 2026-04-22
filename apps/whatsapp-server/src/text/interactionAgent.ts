/**
 * WhatsApp text interaction agent runtime.
 *
 * Responsibilities:
 * - Run the OpenPoke-style interaction loop for one WhatsApp text turn
 * - Execute interaction tools and aggregate user-visible WhatsApp actions
 * - Hand off external work to the execution agent when needed
 */

import { createWhatsAppTextExecutionAgent, type WhatsAppTextExecutionAgent } from "./executionAgent.js";
import { getWhatsAppTextAgentEnv } from "./env.js";
import {
  FetchOpenRouterTextClient,
  type OpenRouterChatMessageDto,
  type OpenRouterTextClient,
  type OpenRouterToolCallDto,
  type OpenRouterToolSchemaDto,
} from "./openRouterClient.js";
import {
  buildWhatsAppTextSystemPrompt,
  buildWhatsAppTextUserPrompt,
} from "./promptBuilder.js";
import type {
  ExecuteAgentRequestDto,
  PreparedTextTurnDto,
  RunInteractionTurnResultDto,
  SupportedConnectorToolkit,
  WhatsAppUserVisibleActionDto,
} from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

interface ToolExecutionSummary {
  actions: WhatsAppUserVisibleActionDto[];
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

export interface SendDraftArgumentsDto {
  body: string;
  subject: string;
  to: string;
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

const WHATSAPP_TEXT_INTERACTION_MODEL = "google/gemini-3-flash-preview";
const MAX_TOOL_ITERATIONS = 8;
const SUPPORTED_CONNECTOR_TOOLKITS = [
  "gmail",
  "googlecalendar",
  "notion",
  "outlook",
] as const;

const INTERACTION_TOOL_SCHEMAS: OpenRouterToolSchemaDto[] = [
  {
    type: "function",
    function: {
      name: "send_message_to_agent",
      description:
        "Run a task through the execution agent. Use this for external app work, lookups, drafting, or any task that needs tools.",
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
      description: "Record a plain-text WhatsApp message for the user.",
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
      name: "send_draft",
      description: "Record a draft for the user to review before any send action.",
      parameters: {
        additionalProperties: false,
        properties: {
          body: {
            description: "Draft body text.",
            type: "string",
          },
          subject: {
            description: "Draft subject line.",
            type: "string",
          },
          to: {
            description: "Draft recipient.",
            type: "string",
          },
        },
        required: ["to", "subject", "body"],
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
            enum: SUPPORTED_CONNECTOR_TOOLKITS,
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

export class WhatsAppInteractionAgent {
  private readonly executionAgent: WhatsAppTextExecutionAgent;
  private readonly openRouterClient: OpenRouterTextClient;

  /**
   * Creates the WhatsApp interaction runtime.
   * @param openRouterClient - OpenRouter client used for interaction planning
   * @param executionAgent - Execution agent used for external tasks
   */
  constructor(
    openRouterClient: OpenRouterTextClient,
    executionAgent: WhatsAppTextExecutionAgent
  ) {
    this.openRouterClient = openRouterClient;
    this.executionAgent = executionAgent;
  }

  /**
   * Runs the interaction loop for one prepared WhatsApp turn.
   * @param turn - Prepared WhatsApp text turn
   * @param emitAction - Optional callback for immediate user-visible actions
   * @returns User-visible actions produced by the interaction loop
   */
  async runTurn(
    turn: PreparedTextTurnDto,
    emitAction?: (action: WhatsAppUserVisibleActionDto) => Promise<void>
  ): Promise<RunInteractionTurnResultDto> {
    console.info("[whatsapp-server] interaction turn started", {
      currentMessageId: turn.currentMessage.id,
      currentMessageLength: turn.currentMessage.text.length,
      historyCount: turn.conversationHistory.length,
      memoryCount: turn.memoryEntries.length,
      userId: turn.linkedUser.userId,
    });

    const messages: OpenRouterChatMessageDto[] = [
      {
        role: "system",
        content: buildWhatsAppTextSystemPrompt(),
      },
      {
        role: "user",
        content: buildWhatsAppTextUserPrompt(turn),
      },
    ];
    const actions: WhatsAppUserVisibleActionDto[] = [];
    let waitRequested = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      console.info("[whatsapp-server] interaction iteration requesting LLM step", {
        currentMessageId: turn.currentMessage.id,
        iteration: iteration + 1,
        messageCount: messages.length,
      });

      const assistantMessage = await this.openRouterClient.createChatCompletion({
        messages,
        tools: INTERACTION_TOOL_SCHEMAS,
      });

      console.info("[whatsapp-server] interaction iteration received LLM step", {
        currentMessageId: turn.currentMessage.id,
        iteration: iteration + 1,
        assistantTextLength: assistantMessage.content.length,
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

      if (assistantMessage.toolCalls.length === 0) {
        throw new Error("Interaction agent returned plain text without a supported tool call");
      }

      const toolSummaries = await Promise.all(
        assistantMessage.toolCalls.map((toolCall) => this.executeToolCall(turn, toolCall, emitAction))
      );

      for (let index = 0; index < assistantMessage.toolCalls.length; index += 1) {
        const toolCall = assistantMessage.toolCalls[index];
        const summary = toolSummaries[index];
        if (!summary) {
          throw new Error(`Missing tool summary for tool call ${toolCall.name}`);
        }

        actions.push(...summary.actions);
        waitRequested = waitRequested || summary.waitRequested;
        console.info("[whatsapp-server] interaction tool completed", {
          currentMessageId: turn.currentMessage.id,
          emittedActionCount: summary.actions.length,
          iteration: iteration + 1,
          shouldContinue: summary.shouldContinue,
          toolName: toolCall.name,
          waitRequested: summary.waitRequested,
        });
        messages.push({
          content: summary.toolResult,
          role: "tool",
          toolCallId: toolCall.id ?? toolCall.name,
        });
      }

      if (!toolSummaries.some((summary) => summary.shouldContinue)) {
        console.info("[whatsapp-server] interaction turn completed", {
          currentMessageId: turn.currentMessage.id,
          emittedActionCount: actions.length,
          finalStatus: waitRequested && actions.length === 0 ? "wait" : "completed",
        });

        return {
          actions,
          status: waitRequested && actions.length === 0 ? "wait" : "completed",
        };
      }
    }

    throw new Error("Interaction agent reached the tool-iteration limit without finishing");
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Executes one interaction tool call and returns the loop summary.
   * @param turn - Prepared WhatsApp turn
   * @param toolCall - Parsed OpenRouter tool call
   * @returns Tool result plus loop metadata
   */
  private async executeToolCall(
    turn: PreparedTextTurnDto,
    toolCall: OpenRouterToolCallDto,
    emitAction?: (action: WhatsAppUserVisibleActionDto) => Promise<void>
  ): Promise<ToolExecutionSummary & { toolResult: string }> {
    if (toolCall.name === "send_message_to_agent") {
      const argumentsDto = parseSendMessageToAgentArguments(toolCall.arguments);
      console.info("[whatsapp-server] interaction tool send_message_to_agent", {
        agentName: argumentsDto.agent_name,
        currentMessageId: turn.currentMessage.id,
        instructionLength: argumentsDto.instructions.length,
      });
      const result = await this.executionAgent.execute({
        agentName: argumentsDto.agent_name,
        instructions: argumentsDto.instructions,
        linkedUser: turn.linkedUser,
      } satisfies ExecuteAgentRequestDto);

      console.info("[whatsapp-server] execution agent returned to interaction agent", {
        agentName: result.agentName,
        currentMessageId: turn.currentMessage.id,
        responseLength: result.response.length,
        success: result.success,
      });

      return {
        actions: [],
        shouldContinue: true,
        toolResult: JSON.stringify({
          agent_name: result.agentName,
          response: result.response,
          success: result.success,
        }),
        waitRequested: false,
      };
    }

    if (toolCall.name === "send_message_to_user") {
      const argumentsDto = parseSendMessageToUserArguments(toolCall.arguments);
      const action = {
        message: argumentsDto.message,
        type: "message",
      } satisfies WhatsAppUserVisibleActionDto;
      console.info("[whatsapp-server] interaction tool send_message_to_user", {
        currentMessageId: turn.currentMessage.id,
        messageLength: argumentsDto.message.length,
      });
      if (emitAction) {
        await emitAction(action);
      }

      return {
        actions: [action],
        shouldContinue: false,
        toolResult: JSON.stringify({
          message: argumentsDto.message,
          status: "recorded",
        }),
        waitRequested: false,
      };
    }

    if (toolCall.name === "send_draft") {
      const argumentsDto = parseSendDraftArguments(toolCall.arguments);
      const action = {
        body: argumentsDto.body,
        subject: argumentsDto.subject,
        to: argumentsDto.to,
        type: "draft",
      } satisfies WhatsAppUserVisibleActionDto;
      console.info("[whatsapp-server] interaction tool send_draft", {
        currentMessageId: turn.currentMessage.id,
        bodyLength: argumentsDto.body.length,
        subjectLength: argumentsDto.subject.length,
        to: argumentsDto.to,
      });
      if (emitAction) {
        await emitAction(action);
      }

      return {
        actions: [action],
        shouldContinue: false,
        toolResult: JSON.stringify({
          status: "draft_recorded",
          to: argumentsDto.to,
          subject: argumentsDto.subject,
        }),
        waitRequested: false,
      };
    }

    if (toolCall.name === "send_whatsapp_auth_template") {
      const argumentsDto = parseSendWhatsAppAuthTemplateArguments(toolCall.arguments);
      const action = {
        toolkit: argumentsDto.toolkit,
        type: "auth_template",
      } satisfies WhatsAppUserVisibleActionDto;
      console.info("[whatsapp-server] interaction tool send_whatsapp_auth_template", {
        currentMessageId: turn.currentMessage.id,
        toolkit: argumentsDto.toolkit,
      });
      if (emitAction) {
        await emitAction(action);
      }

      return {
        actions: [action],
        shouldContinue: true,
        toolResult: JSON.stringify({
          status: "auth_template_sent",
          toolkit: argumentsDto.toolkit,
        }),
        waitRequested: false,
      };
    }

    if (toolCall.name === "send_whatsapp_connector_overview") {
      parseSendWhatsAppConnectorOverviewArguments(toolCall.arguments);
      const action = {
        type: "connector_overview",
      } satisfies WhatsAppUserVisibleActionDto;
      console.info("[whatsapp-server] interaction tool send_whatsapp_connector_overview", {
        currentMessageId: turn.currentMessage.id,
      });
      if (emitAction) {
        await emitAction(action);
      }

      return {
        actions: [action],
        shouldContinue: true,
        toolResult: JSON.stringify({
          status: "connector_overview_sent",
        }),
        waitRequested: false,
      };
    }

    if (toolCall.name === "wait") {
      const argumentsDto = parseWaitArguments(toolCall.arguments);
      console.info("[whatsapp-server] interaction tool wait", {
        currentMessageId: turn.currentMessage.id,
        reason: argumentsDto.reason,
      });
      return {
        actions: [],
        shouldContinue: false,
        toolResult: JSON.stringify({
          reason: argumentsDto.reason,
          status: "waiting",
        }),
        waitRequested: true,
      };
    }

    throw new Error(`Unsupported interaction tool: ${toolCall.name}`);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Creates the default WhatsApp interaction runtime from env.
 * @returns Ready-to-use interaction runtime
 */
export function createWhatsAppInteractionAgent(): WhatsAppInteractionAgent {
  const env = getWhatsAppTextAgentEnv();

  return new WhatsAppInteractionAgent(
    new FetchOpenRouterTextClient({
      apiKey: env.openRouterApiKey,
      model: WHATSAPP_TEXT_INTERACTION_MODEL,
    }),
    createWhatsAppTextExecutionAgent()
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
 * Parses and validates one send-draft argument object.
 * @param value - Raw tool arguments
 * @returns Validated tool arguments
 */
function parseSendDraftArguments(
  value: Record<string, unknown>
): SendDraftArgumentsDto {
  return {
    body: requireString(value.body, "send_draft.body"),
    subject: requireString(value.subject, "send_draft.subject"),
    to: requireString(value.to, "send_draft.to"),
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
 * Parses and validates one connector-overview argument object.
 * @param value - Raw tool arguments
 * @returns Empty DTO when valid
 */
function parseSendWhatsAppConnectorOverviewArguments(
  value: Record<string, unknown>
): SendWhatsAppConnectorOverviewArgumentsDto {
  const extraKeys = Object.keys(value);
  if (extraKeys.length > 0) {
    throw new Error(
      `send_whatsapp_connector_overview does not accept arguments. Received: ${extraKeys.join(", ")}`
    );
  }

  return {};
}

/**
 * Validates one required string tool argument.
 * @param value - Raw unknown value
 * @param fieldName - Field name used in error messages
 * @returns Trimmed string value
 */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

/**
 * Validates one supported connector toolkit value.
 * @param value - Raw unknown value
 * @param fieldName - Field name used in error messages
 * @returns Supported connector toolkit
 */
function requireSupportedConnectorToolkit(
  value: unknown,
  fieldName: string
): SupportedConnectorToolkit {
  const toolkit = requireString(value, fieldName).toLowerCase();
  if (!SUPPORTED_CONNECTOR_TOOLKITS.includes(toolkit as SupportedConnectorToolkit)) {
    throw new Error(`${fieldName} must be one of: ${SUPPORTED_CONNECTOR_TOOLKITS.join(", ")}`);
  }

  return toolkit as SupportedConnectorToolkit;
}
