/**
 * Shared execution prompt budgeting helpers.
 *
 * Responsibilities:
 * - Keep executor history under a prompt-size budget
 * - Preserve assistant/tool replay units while trimming old history
 * - Use one shared prompt-size estimate for text and voice executors
 */

import type { ExecutionAgentMessageDto } from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

interface FitExecutionHistoryToBudgetInputDto {
  maxPromptTokens: number;
  persistedMessages: ExecutionAgentMessageDto[];
  systemMessage: string;
  toolSchemas: unknown[];
  userMessage: string;
}

interface ExecutionHistoryReplayUnitDto {
  messages: ExecutionAgentMessageDto[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ESTIMATED_CHARACTERS_PER_TOKEN = 3;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Trims persisted execution history until the estimated prompt fits the budget.
 * Preserves assistant/tool-call pairs as one replay unit.
 * @param input - Prompt budgeting input
 * @returns Replay-safe persisted messages that fit within the estimated budget
 */
export function fitExecutionHistoryToTokenBudget(
  input: FitExecutionHistoryToBudgetInputDto
): ExecutionAgentMessageDto[] {
  const replayUnits = groupExecutionMessagesIntoReplayUnits(input.persistedMessages);
  let retainedUnits = [...replayUnits];

  while (retainedUnits.length > 0) {
    const retainedMessages = retainedUnits.flatMap((unit) => unit.messages);
    const estimatedPromptTokens = estimateExecutionPromptTokens({
      persistedMessages: retainedMessages,
      systemMessage: input.systemMessage,
      toolSchemas: input.toolSchemas,
      userMessage: input.userMessage,
    });

    if (estimatedPromptTokens < input.maxPromptTokens) {
      return retainedMessages;
    }

    retainedUnits = retainedUnits.slice(1);
  }

  return [];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Groups persisted execution messages into replay-safe trimming units.
 * @param messages - Persisted execution history in chronological order
 * @returns Ordered replay units
 */
function groupExecutionMessagesIntoReplayUnits(
  messages: ExecutionAgentMessageDto[]
): ExecutionHistoryReplayUnitDto[] {
  const replayUnits: ExecutionHistoryReplayUnitDto[] = [];
  let currentIndex = 0;

  while (currentIndex < messages.length) {
    const currentMessage = messages[currentIndex];
    if (!currentMessage) {
      break;
    }

    if (currentMessage.role === "tool") {
      currentIndex += 1;
      continue;
    }

    if (currentMessage.role !== "assistant" || !currentMessage.toolCalls?.length) {
      replayUnits.push({
        messages: [currentMessage],
      });
      currentIndex += 1;
      continue;
    }

    const toolCallIds = new Set(
      currentMessage.toolCalls
        .map((toolCall) => toolCall.id ?? toolCall.name)
        .filter((toolCallId): toolCallId is string => Boolean(toolCallId))
    );
    const groupedMessages = [currentMessage];
    currentIndex += 1;

    while (currentIndex < messages.length) {
      const nextMessage = messages[currentIndex];
      if (!nextMessage || nextMessage.role !== "tool") {
        break;
      }

      if (!nextMessage.toolCallId || !toolCallIds.has(nextMessage.toolCallId)) {
        break;
      }

      groupedMessages.push(nextMessage);
      currentIndex += 1;
    }

    if (
      toolCallIds.size === currentMessage.toolCalls.length &&
      groupedMessages.length === toolCallIds.size + 1
    ) {
      replayUnits.push({
        messages: groupedMessages,
      });
    }
  }

  return replayUnits;
}

/**
 * Estimates total prompt tokens for one execution request.
 * @param input - Prompt estimation input
 * @returns Estimated token count
 */
function estimateExecutionPromptTokens(
  input: Omit<FitExecutionHistoryToBudgetInputDto, "maxPromptTokens">
): number {
  const serializedPrompt = JSON.stringify({
    messages: [
      {
        content: input.systemMessage,
        role: "system",
      },
      ...input.persistedMessages.map((message) => ({
        content: message.content,
        role: message.role,
        toolArguments: message.toolArguments,
        toolCallId: message.toolCallId,
        toolCalls: message.toolCalls,
        toolName: message.toolName,
      })),
      {
        content: input.userMessage,
        role: "user",
      },
    ],
    tools: input.toolSchemas,
  });

  return Math.ceil(serializedPrompt.length / ESTIMATED_CHARACTERS_PER_TOKEN);
}
