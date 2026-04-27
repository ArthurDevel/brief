import { describe, expect, it } from "vitest";
import { fitExecutionHistoryToTokenBudget } from "../executionPromptBudget.js";
import type { ExecutionAgentMessageDto } from "../types.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds one persisted execution-agent message for budgeting tests.
 * @param overrides - Partial message overrides
 * @returns Persisted execution-agent message
 */
function createExecutionMessage(
  overrides: Partial<ExecutionAgentMessageDto>
): ExecutionAgentMessageDto {
  return {
    content: "",
    createdAt: "2026-04-27T00:00:00.000Z",
    id: "message-1",
    role: "user",
    threadId: "thread-1",
    toolArguments: null,
    toolCallId: null,
    toolCalls: null,
    toolName: null,
    toolResult: null,
    userId: "user-1",
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("fitExecutionHistoryToTokenBudget", () => {
  it("keeps the full persisted history when already under budget", () => {
    const persistedMessages = [
      createExecutionMessage({
        content: "Check the inbox.",
        id: "message-1",
      }),
      createExecutionMessage({
        content: "I found one email.",
        id: "message-2",
        role: "assistant",
      }),
    ];

    const retainedMessages = fitExecutionHistoryToTokenBudget({
      maxPromptTokens: 10000,
      persistedMessages,
      systemMessage: "System prompt",
      toolSchemas: [],
      userMessage: "Continue.",
    });

    expect(retainedMessages).toEqual(persistedMessages);
  });

  it("drops the oldest replay unit when the prompt is oversized", () => {
    const persistedMessages = [
      createExecutionMessage({
        content: "A".repeat(1800),
        id: "message-1",
      }),
      createExecutionMessage({
        content: "Latest user message",
        id: "message-2",
      }),
    ];

    const retainedMessages = fitExecutionHistoryToTokenBudget({
      maxPromptTokens: 120,
      persistedMessages,
      systemMessage: "System prompt",
      toolSchemas: [],
      userMessage: "Continue.",
    });

    expect(retainedMessages).toEqual([
      expect.objectContaining({
        id: "message-2",
      }),
    ]);
  });

  it("preserves assistant tool-call messages together with their tool results", () => {
    const persistedMessages = [
      createExecutionMessage({
        content: "Earlier note",
        id: "message-1",
      }),
      createExecutionMessage({
        content: "B".repeat(1200),
        id: "message-2",
        role: "assistant",
        toolCalls: [
          {
            arguments: {
              query: "in:inbox",
            },
            id: "tool-1",
            name: "GMAIL_FETCH_EMAILS",
          },
        ],
      }),
      createExecutionMessage({
        content: "C".repeat(1200),
        id: "message-3",
        role: "tool",
        toolArguments: {
          query: "in:inbox",
        },
        toolCallId: "tool-1",
        toolName: "GMAIL_FETCH_EMAILS",
        toolResult: {
          ok: true,
        },
      }),
      createExecutionMessage({
        content: "Recent user message",
        id: "message-4",
      }),
    ];

    const retainedMessages = fitExecutionHistoryToTokenBudget({
      maxPromptTokens: 80,
      persistedMessages,
      systemMessage: "System prompt",
      toolSchemas: [],
      userMessage: "Continue.",
    });

    expect(retainedMessages).toEqual([
      expect.objectContaining({
        id: "message-4",
      }),
    ]);
  });
});
