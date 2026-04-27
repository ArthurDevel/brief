import { describe, expect, it, vi } from "vitest";
import type { LlmTextClient } from "@dublin/llm/types";
import type {
  ExecutionAgentMessageDto,
  ExecutionAgentThreadDto,
  StoreExecutionAgentMessagesDto,
  TouchExecutionAgentThreadDto,
  WhatsAppCoreStore,
} from "@dublin/whatsapp-core";
import { WhatsAppTextExecutionAgentRuntime } from "../text/executionAgent.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates the standard execution request used in tests.
 * @returns Execution request DTO
 */
function createExecutionRequest() {
  return {
    agentName: "Gmail Agent",
    instructions: "Check the inbox for urgent mail.",
    linkedUser: {
      userId: "user-1",
      whatsappPhone: "+15551234567",
    },
  };
}

/**
 * Creates one in-memory execution-agent store mock.
 * @returns Mock WhatsApp core store with persisted execution threads and messages
 */
function createMockWhatsAppCoreStore(): WhatsAppCoreStore {
  const threadsByKey = new Map<string, ExecutionAgentThreadDto>();
  const messagesByThreadId = new Map<string, ExecutionAgentMessageDto[]>();
  let threadCounter = 1;
  let messageCounter = 1;

  return {
    findOrCreateExecutionAgentThread: vi.fn().mockImplementation(
      async ({ agentName, userId }: { agentName: string; userId: string }) => {
        const threadKey = `${userId}:${agentName}`;
        const existingThread = threadsByKey.get(threadKey);
        if (existingThread) {
          return existingThread;
        }

        const thread: ExecutionAgentThreadDto = {
          agentName,
          createdAt: `2026-04-23T00:00:0${threadCounter}.000Z`,
          id: `thread-${threadCounter}`,
          updatedAt: `2026-04-23T00:00:0${threadCounter}.000Z`,
          userId,
        };
        threadCounter += 1;
        threadsByKey.set(threadKey, thread);
        messagesByThreadId.set(thread.id, []);
        return thread;
      }
    ),
    getUserMemoryEntries: vi.fn(),
    listConversationMessages: vi.fn(),
    listExecutionAgentMessages: vi.fn().mockImplementation(
      async ({ limit, threadId, userId }: { limit: number; threadId: string; userId: string }) => {
        const messages = messagesByThreadId.get(threadId) ?? [];

        return messages
          .filter((message) => message.userId === userId)
          .slice(-limit);
      }
    ),
    requireLinkedUserByPhone: vi.fn(),
    storeExecutionAgentMessages: vi.fn().mockImplementation(
      async (input: StoreExecutionAgentMessagesDto) => {
        const existingMessages = messagesByThreadId.get(input.threadId) ?? [];
        const storedMessages = input.messages.map((message) => {
          const storedMessage: ExecutionAgentMessageDto = {
            content: message.content,
            createdAt: `2026-04-23T00:00:${String(messageCounter).padStart(2, "0")}.000Z`,
            id: `message-${messageCounter}`,
            role: message.role,
            threadId: input.threadId,
            toolArguments: message.toolArguments,
            toolCallId: message.toolCallId,
            toolCalls: message.toolCalls,
            toolName: message.toolName,
            toolResult: message.toolResult,
            userId: input.userId,
          };
          messageCounter += 1;
          return storedMessage;
        });

        messagesByThreadId.set(input.threadId, [...existingMessages, ...storedMessages]);
        return storedMessages;
      }
    ),
    storeInboundTextMessage: vi.fn(),
    storeOutboundTextMessage: vi.fn(),
    touchExecutionAgentThread: vi.fn().mockImplementation(
      async ({ threadId }: TouchExecutionAgentThreadDto) => {
        const thread = [...threadsByKey.values()].find((candidate) => candidate.id === threadId);
        if (!thread) {
          throw new Error(`Unknown thread ${threadId}`);
        }

        thread.updatedAt = `2026-04-23T01:00:00.000Z`;
      }
    ),
  } as unknown as WhatsAppCoreStore;
}

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppTextExecutionAgentRuntime", () => {
  it("continues the persisted execution conversation for the same user and agent name", async () => {
    const executionClient: LlmTextClient = {
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({
          content: "Found one urgent email.",
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: "That same urgent email is still at the top.",
          toolCalls: [],
        }),
    };
    const summarizerClient: LlmTextClient = {
      createChatCompletion: vi.fn(),
    };
    const coreStore = createMockWhatsAppCoreStore();
    const runtime = new WhatsAppTextExecutionAgentRuntime(
      executionClient,
      summarizerClient,
      coreStore,
      "composio-key",
      "whatsapp-token",
      "23",
      "phone-id"
    );

    vi.spyOn(runtime as never, "createExecutionSession").mockResolvedValue({
      connectedToolkitSlugs: ["gmail"],
      executeTool: vi.fn(),
      toolSchemas: [],
    });

    await runtime.execute(createExecutionRequest());
    await runtime.execute({
      ...createExecutionRequest(),
      instructions: "Check again and continue from where you left off.",
    });

    const secondExecutionRequest = vi.mocked(executionClient.createChatCompletion).mock.calls[1]?.[0];

    expect(secondExecutionRequest?.tools).toEqual([]);
    expect(secondExecutionRequest?.messages.slice(0, 4)).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Agent Name: Gmail Agent"),
        role: "system",
      }),
      {
        content: "Check the inbox for urgent mail.",
        role: "user",
      },
      {
        content: "Found one urgent email.",
        role: "assistant",
      },
      {
        content: "Check again and continue from where you left off.",
        role: "user",
      },
    ]);
    expect(coreStore.listExecutionAgentMessages).toHaveBeenNthCalledWith(2, {
      limit: 20,
      threadId: "thread-1",
      userId: "user-1",
    });
  });

  it("stores assistant tool calls and tool results in the execution message history", async () => {
    const executionClient: LlmTextClient = {
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({
          content: "Checking Gmail tools now.",
          toolCalls: [
            {
              arguments: {
                queries: ["urgent inbox"],
              },
              id: "tool-1",
              name: "COMPOSIO_SEARCH_TOOLS",
            },
          ],
        })
        .mockResolvedValueOnce({
          content: "I found one urgent email from Sarah.",
          toolCalls: [],
        }),
    };
    const summarizerClient: LlmTextClient = {
      createChatCompletion: vi.fn(),
    };
    const coreStore = createMockWhatsAppCoreStore();
    const runtime = new WhatsAppTextExecutionAgentRuntime(
      executionClient,
      summarizerClient,
      coreStore,
      "composio-key",
      "whatsapp-token",
      "23",
      "phone-id"
    );

    vi.spyOn(runtime as never, "createExecutionSession").mockResolvedValue({
      connectedToolkitSlugs: ["gmail"],
      executeTool: vi.fn().mockResolvedValue({
        data: {
          ok: true,
        },
      }),
      toolSchemas: [
        {
          function: {
            description: "Search tools",
            name: "COMPOSIO_SEARCH_TOOLS",
            parameters: {
              type: "object",
            },
          },
          type: "function",
        },
      ],
    });

    await runtime.execute(createExecutionRequest());

    const threadMessages = await coreStore.listExecutionAgentMessages({
      limit: 20,
      threadId: "thread-1",
      userId: "user-1",
    });

    expect(threadMessages).toEqual([
      expect.objectContaining({
        content: "Check the inbox for urgent mail.",
        role: "user",
      }),
      expect.objectContaining({
        content: "Checking Gmail tools now.",
        role: "assistant",
        toolCalls: [
          {
            arguments: {
              queries: ["urgent inbox"],
            },
            id: "tool-1",
            name: "COMPOSIO_SEARCH_TOOLS",
          },
        ],
      }),
      expect.objectContaining({
        role: "tool",
        toolArguments: {
          queries: ["urgent inbox"],
        },
        toolCallId: "tool-1",
        toolName: "COMPOSIO_SEARCH_TOOLS",
        toolResult: {
          arguments: {
            queries: ["urgent inbox"],
          },
          result: {
            data: {
              ok: true,
            },
            logId: null,
            tool: "COMPOSIO_SEARCH_TOOLS",
          },
          status: "success",
          tool: "COMPOSIO_SEARCH_TOOLS",
        },
      }),
      expect.objectContaining({
        content: "I found one urgent email from Sarah.",
        role: "assistant",
      }),
    ]);
  });

  it("shrinks nested Gmail fetch results before storing tool history", async () => {
    const executionClient: LlmTextClient = {
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({
          content: "Checking the inbox now.",
          toolCalls: [
            {
              arguments: {
                tools: [
                  {
                    arguments: {
                      max_results: 5,
                      query: "in:inbox",
                    },
                    tool_slug: "GMAIL_FETCH_EMAILS",
                  },
                ],
              },
              id: "tool-1",
              name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            },
          ],
        })
        .mockResolvedValueOnce({
          content: "I found the latest inbox emails.",
          toolCalls: [],
        }),
    };
    const summarizerClient: LlmTextClient = {
      createChatCompletion: vi.fn(),
    };
    const coreStore = createMockWhatsAppCoreStore();
    const runtime = new WhatsAppTextExecutionAgentRuntime(
      executionClient,
      summarizerClient,
      coreStore,
      "composio-key",
      "whatsapp-token",
      "23",
      "phone-id"
    );

    vi.spyOn(runtime as never, "createExecutionSession").mockResolvedValue({
      connectedToolkitSlugs: ["gmail"],
      executeTool: vi.fn().mockResolvedValue({
        data: {
          results: [
            {
              index: 0,
              response: {
                data: {
                  messages: [
                    {
                      display_url: "https://mail.google.com/mail/u/0/#inbox/abc",
                      labelIds: ["UNREAD", "INBOX"],
                      messageId: "message-1",
                      messageText:
                        "<html><body>This very large HTML email should not be kept in execution history.</body></html>",
                      payload: {
                        headers: [
                          {
                            name: "From",
                            value: "Sarah <sarah@example.com>",
                          },
                          {
                            name: "To",
                            value: "team@example.com",
                          },
                          {
                            name: "Subject",
                            value: "Urgent update",
                          },
                        ],
                      },
                      threadId: "thread-1",
                    },
                  ],
                },
                successful: true,
              },
            },
          ],
        },
      }),
      toolSchemas: [
        {
          function: {
            description: "Run one or more tools",
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            parameters: {
              type: "object",
            },
          },
          type: "function",
        },
      ],
    });

    await runtime.execute(createExecutionRequest());

    const threadMessages = await coreStore.listExecutionAgentMessages({
      limit: 20,
      threadId: "thread-1",
      userId: "user-1",
    });
    const storedToolMessage = threadMessages.find((message) => message.role === "tool");

    expect(storedToolMessage?.toolResult).toEqual({
      arguments: {
        tools: [
          {
            arguments: {
              max_results: 5,
              query: "in:inbox",
            },
            tool_slug: "GMAIL_FETCH_EMAILS",
          },
        ],
      },
      result: {
        data: {
          results: [
            {
              index: 0,
              response: {
                data: {
                  messages: [
                    {
                      from: "Sarah <sarah@example.com>",
                      id: "message-1",
                      labels: ["INBOX"],
                      preview:
                        "This very large HTML email should not be kept in execution history.",
                      receivedAt: null,
                      subject: "Urgent update",
                      threadId: "thread-1",
                      to: "team@example.com",
                      unread: true,
                      url: "https://mail.google.com/mail/u/0/#inbox/abc",
                    },
                  ],
                  resultSizeEstimate: 1,
                },
                successful: true,
              },
              toolSlug: "GMAIL_FETCH_EMAILS",
            },
          ],
        },
        logId: null,
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
      },
      status: "success",
      tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
    });
    expect(JSON.stringify(storedToolMessage?.toolResult)).not.toContain("messageText");
  });

  it("returns a summarized failure when the execution loop reaches the iteration limit", async () => {
    const executionClient: LlmTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content: "I will keep checking tools.",
        toolCalls: [
          {
            arguments: {
              queries: ["urgent inbox"],
            },
            id: "tool-1",
            name: "COMPOSIO_SEARCH_TOOLS",
          },
        ],
      }),
    };
    const summarizerClient: LlmTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content:
          "The agent repeatedly searched Gmail-related tools but never produced a final inbox summary, so the task stopped after hitting the execution iteration limit.",
        toolCalls: [],
      }),
    };
    const coreStore = createMockWhatsAppCoreStore();
    const runtime = new WhatsAppTextExecutionAgentRuntime(
      executionClient,
      summarizerClient,
      coreStore,
      "composio-key",
      "whatsapp-token",
      "23",
      "phone-id"
    );

    vi.spyOn(runtime as any, "createExecutionSession").mockResolvedValue({
      connectedToolkitSlugs: ["gmail"],
      executeTool: vi.fn().mockResolvedValue({
        data: {
          ok: true,
        },
      }),
      toolSchemas: [
        {
          function: {
            description: "Search tools",
            name: "COMPOSIO_SEARCH_TOOLS",
            parameters: {
              type: "object",
            },
          },
          type: "function",
        },
      ],
    });

    const result = await runtime.execute(createExecutionRequest());

    expect(result).toEqual({
      agentName: "Gmail Agent",
      response:
        "The agent repeatedly searched Gmail-related tools but never produced a final inbox summary, so the task stopped after hitting the execution iteration limit.",
      success: false,
    });
    expect(executionClient.createChatCompletion).toHaveBeenCalledTimes(8);
    expect(summarizerClient.createChatCompletion).toHaveBeenCalledTimes(1);
  });
});
