import { describe, expect, it, vi } from "vitest";
import { WhatsAppInteractionAgent } from "../text/interactionAgent.js";
import type {
  OpenRouterAssistantMessageDto,
  OpenRouterTextClient,
} from "../text/openRouterClient.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a standard prepared turn for interaction-agent tests.
 * @returns Prepared turn DTO
 */
function createPreparedTurn() {
  return {
    conversationHistory: [],
    currentMessage: {
      id: "message-1",
      contactPhoneNumber: "+15551234567",
      createdAt: "2026-04-22T10:00:00.000Z",
      direction: "inbound" as const,
      metaMessageId: "wamid.1",
      status: "received",
      text: "check my inbox",
      userId: "user-1",
    },
    executionAgentThreads: [],
    linkedUser: {
      userId: "user-1",
      whatsappPhone: "+15551234567",
    },
    memoryEntries: [],
  };
}

/**
 * Creates an OpenRouter client mock that returns responses in order.
 * @param responses - Assistant responses to emit on each call
 * @returns Mock OpenRouter client
 */
function createMockOpenRouterClient(
  responses: OpenRouterAssistantMessageDto[]
): OpenRouterTextClient {
  return {
    createChatCompletion: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more mocked OpenRouter responses");
      }

      return response;
    }),
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppInteractionAgent", () => {
  it("hands off to the execution agent and then returns the user message", async () => {
    const openRouterClient = createMockOpenRouterClient([
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              message: "Checking now.",
            },
            id: "tool-1",
            name: "send_message_to_user",
          },
          {
            arguments: {
              agent_name: "Inbox helper",
              instructions: "Check the inbox for urgent mail.",
            },
            id: "tool-2",
            name: "send_message_to_agent",
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              message: "You have one urgent email from Sarah.",
            },
            id: "tool-3",
            name: "send_message_to_user",
          },
        ],
      },
    ]);
    const executionAgent = {
      execute: vi.fn().mockResolvedValue({
        agentName: "Inbox helper",
        response: "Found one urgent email from Sarah.",
        success: true,
      }),
    };
    const agent = new WhatsAppInteractionAgent(openRouterClient, executionAgent);

    const result = await agent.runTurn(createPreparedTurn());

    expect(executionAgent.execute).toHaveBeenCalledWith({
      agentName: "Inbox helper",
      instructions: "Check the inbox for urgent mail.",
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
    });
    expect(result).toEqual({
      actions: [
        {
          message: "Checking now.",
          type: "message",
        },
        {
          message: "You have one urgent email from Sarah.",
          type: "message",
        },
      ],
      status: "completed",
    });
  });

  it("returns wait without sending a user-visible action", async () => {
    const openRouterClient = createMockOpenRouterClient([
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              reason: "That exact confirmation is already in the history.",
            },
            id: "tool-1",
            name: "wait",
          },
        ],
      },
    ]);
    const executionAgent = {
      execute: vi.fn(),
    };
    const agent = new WhatsAppInteractionAgent(openRouterClient, executionAgent);

    const result = await agent.runTurn(createPreparedTurn());

    expect(executionAgent.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      actions: [],
      status: "wait",
    });
  });

  it("records drafts as user-visible actions", async () => {
    const openRouterClient = createMockOpenRouterClient([
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              body: "Here is the draft body.",
              subject: "Draft subject",
              to: "sarah@example.com",
            },
            id: "tool-1",
            name: "send_draft",
          },
          {
            arguments: {
              message: "Want me to send it?",
            },
            id: "tool-2",
            name: "send_message_to_user",
          },
        ],
      },
    ]);
    const executionAgent = {
      execute: vi.fn(),
    };
    const agent = new WhatsAppInteractionAgent(openRouterClient, executionAgent);

    const result = await agent.runTurn(createPreparedTurn());

    expect(result).toEqual({
      actions: [
        {
          body: "Here is the draft body.",
          subject: "Draft subject",
          to: "sarah@example.com",
          type: "draft",
        },
        {
          message: "Want me to send it?",
          type: "message",
        },
      ],
      status: "completed",
    });
  });

  it("can send a WhatsApp auth template directly before the follow-up message", async () => {
    const openRouterClient = createMockOpenRouterClient([
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              toolkit: "outlook",
            },
            id: "tool-1",
            name: "send_whatsapp_auth_template",
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            arguments: {
              message: "I just sent the Outlook connect link. Open it and try again once it is connected.",
            },
            id: "tool-2",
            name: "send_message_to_user",
          },
        ],
      },
    ]);
    const executionAgent = {
      execute: vi.fn(),
    };
    const agent = new WhatsAppInteractionAgent(openRouterClient, executionAgent);

    const result = await agent.runTurn(createPreparedTurn());

    expect(executionAgent.execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      actions: [
        {
          toolkit: "outlook",
          type: "auth_template",
        },
        {
          message: "I just sent the Outlook connect link. Open it and try again once it is connected.",
          type: "message",
        },
      ],
      status: "completed",
    });
  });
});
