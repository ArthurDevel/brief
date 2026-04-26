import { describe, expect, it, vi } from "vitest";
import { VoiceOpenPokeInteractionAgentRuntime } from "../openpoke/interactionAgent.js";
import type { VoiceExecutionObserver } from "../openpoke/narrationTypes.js";
import {
  buildVoiceOpenPokeConversationStartUserPrompt,
  buildVoiceOpenPokeInteractionSystemPrompt,
  buildVoiceOpenPokeInteractionUserPrompt,
} from "../openpoke/promptBuilder.js";
import type { OpenRouterTextClient } from "../openpoke/openRouterClient.js";
import type { VoiceOpenPokeExecutionAgent } from "../openpoke/executionAgent.js";
import { getDefaultWhatsAppVoiceConfig } from "../voice/types.js";

describe("buildVoiceOpenPokeInteractionUserPrompt", () => {
  it("renders the same text-style tagged sections for a voice turn", () => {
    const prompt = buildVoiceOpenPokeInteractionUserPrompt({
      callerContext: {
        callerPhone: "+15551234567",
        connectionGuidanceMessage: null,
        connectedAccountsByToolkit: {},
        supabaseUserId: "user_123",
        voiceConfig: getDefaultWhatsAppVoiceConfig(),
      },
      conversationHistory: [
        {
          createdAt: "2026-04-23T10:00:00.000Z",
          direction: "outbound",
          text: "How can I help?",
        },
      ],
      currentMessage: {
        createdAt: "2026-04-23T10:01:00.000Z",
        direction: "inbound",
        text: "Check my next meeting",
      },
      memoryEntries: [
        {
          id: "memory_1",
          content: "Prefers short updates.",
        },
      ],
    });

    expect(buildVoiceOpenPokeInteractionSystemPrompt()).toContain("interaction agent");
    expect(prompt).toContain("<channel_context>");
    expect(prompt).toContain("<user_memory>");
    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("<new_user_message>");
    expect(prompt).toContain("Check my next meeting");
  });
});

describe("buildVoiceOpenPokeConversationStartUserPrompt", () => {
  it("renders the conversation-start event for the initial greeting turn", () => {
    const prompt = buildVoiceOpenPokeConversationStartUserPrompt({
      callerContext: {
        callerPhone: "+15551234567",
        connectionGuidanceMessage: null,
        connectedAccountsByToolkit: {},
        supabaseUserId: "user_123",
        voiceConfig: getDefaultWhatsAppVoiceConfig(),
      },
      conversationHistory: [],
      memoryEntries: [
        {
          id: "memory_1",
          content: "Prefers short updates.",
        },
      ],
    });

    expect(prompt).toContain("<channel_context>");
    expect(prompt).toContain("<user_memory>");
    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("<conversation_start>");
    expect(prompt).toContain("Greet the user briefly and ask how you can help.");
  });
});

describe("VoiceOpenPokeInteractionAgentRuntime", () => {
  it("emits the initial greeting from the interaction agent on conversation start", async () => {
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [
          {
            arguments: {
              message: "Hi, how can I help today?",
            },
            id: "tool_start",
            name: "send_message_to_user",
          },
        ],
      }),
    };
    const executionAgent: VoiceOpenPokeExecutionAgent = {
      execute: vi.fn(),
    };
    const emitActionMock = vi.fn().mockResolvedValue(undefined);
    const runtime = new VoiceOpenPokeInteractionAgentRuntime(
      openRouterClient,
      executionAgent
    );

    const result = await runtime.runConversationStart(
      {
        callerContext: {
          callerPhone: "+15551234567",
          connectionGuidanceMessage: null,
          connectedAccountsByToolkit: {},
          supabaseUserId: "user_123",
          voiceConfig: getDefaultWhatsAppVoiceConfig(),
        },
        conversationHistory: [],
        memoryEntries: [],
      },
      emitActionMock
    );

    expect(emitActionMock).toHaveBeenCalledWith({
      message: "Hi, how can I help today?",
      type: "message",
    });
    expect(result).toEqual({
      actions: [
        {
          message: "Hi, how can I help today?",
          type: "message",
        },
      ],
      status: "completed",
    });
  });

  it("delegates to the execution agent and emits the final spoken message", async () => {
    const createChatCompletionMock = vi
      .fn<OpenRouterTextClient["createChatCompletion"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            arguments: {
              agent_name: "calendar",
              instructions: "Find the next meeting.",
            },
            id: "tool_1",
            name: "send_message_to_agent",
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            arguments: {
              message: "Your next meeting is at 3 PM.",
            },
            id: "tool_2",
            name: "send_message_to_user",
          },
        ],
      });
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: createChatCompletionMock,
    };
    const executeMock = vi.fn().mockResolvedValue({
      agentName: "calendar",
      response: "The next meeting is at 3 PM.",
      success: true,
    });
    const executionAgent: VoiceOpenPokeExecutionAgent = {
      execute: executeMock,
    };
    const emitActionMock = vi.fn().mockResolvedValue(undefined);
    const runtime = new VoiceOpenPokeInteractionAgentRuntime(
      openRouterClient,
      executionAgent
    );

    const result = await runtime.runTurn(
      {
        callerContext: {
          callerPhone: "+15551234567",
          connectionGuidanceMessage: null,
          connectedAccountsByToolkit: {},
          supabaseUserId: "user_123",
          voiceConfig: getDefaultWhatsAppVoiceConfig(),
        },
        conversationHistory: [],
        currentMessage: {
          createdAt: "2026-04-23T10:01:00.000Z",
          direction: "inbound",
          text: "Check my next meeting",
        },
        memoryEntries: [],
      },
      emitActionMock
    );

    expect(executeMock).toHaveBeenCalledWith({
      agentName: "calendar",
      callerContext: expect.objectContaining({
        callerPhone: "+15551234567",
      }),
      instructions: "Find the next meeting.",
    }, undefined);
    expect(emitActionMock).toHaveBeenCalledWith({
      message: "Your next meeting is at 3 PM.",
      type: "message",
    });
    expect(result).toEqual({
      actions: [
        {
          message: "Your next meeting is at 3 PM.",
          type: "message",
        },
      ],
      status: "completed",
    });
  });

  it("returns wait when the model chooses the wait tool", async () => {
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [
          {
            arguments: {
              reason: "Already answered.",
            },
            id: "tool_wait",
            name: "wait",
          },
        ],
      }),
    };
    const executionAgent: VoiceOpenPokeExecutionAgent = {
      execute: vi.fn(),
    };
    const runtime = new VoiceOpenPokeInteractionAgentRuntime(
      openRouterClient,
      executionAgent
    );

    const result = await runtime.runTurn({
      callerContext: {
        callerPhone: "+15551234567",
        connectionGuidanceMessage: null,
        connectedAccountsByToolkit: {},
        supabaseUserId: "user_123",
        voiceConfig: getDefaultWhatsAppVoiceConfig(),
      },
      conversationHistory: [],
      currentMessage: {
        createdAt: "2026-04-23T10:01:00.000Z",
        direction: "inbound",
        text: "Anything else?",
      },
      memoryEntries: [],
    });

    expect(result).toEqual({
      actions: [],
      status: "wait",
    });
  });

  it("forwards the execution observer to the execution agent", async () => {
    const createChatCompletionMock = vi
      .fn<OpenRouterTextClient["createChatCompletion"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            arguments: {
              agent_name: "calendar",
              instructions: "Find the next meeting.",
            },
            id: "tool_1",
            name: "send_message_to_agent",
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            arguments: {
              reason: "Done delegating.",
            },
            id: "tool_2",
            name: "wait",
          },
        ],
      });
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: createChatCompletionMock,
    };
    const executeMock = vi.fn().mockResolvedValue({
      agentName: "calendar",
      response: "The next meeting is at 3 PM.",
      success: true,
    });
    const executionAgent: VoiceOpenPokeExecutionAgent = {
      execute: executeMock,
    };
    const executionObserver: VoiceExecutionObserver = {
      onExecutionSnapshot: vi.fn(),
    };
    const runtime = new VoiceOpenPokeInteractionAgentRuntime(
      openRouterClient,
      executionAgent
    );

    await runtime.runTurn(
      {
        callerContext: {
          callerPhone: "+15551234567",
          connectionGuidanceMessage: null,
          connectedAccountsByToolkit: {},
          supabaseUserId: "user_123",
          voiceConfig: getDefaultWhatsAppVoiceConfig(),
        },
        conversationHistory: [],
        currentMessage: {
          createdAt: "2026-04-23T10:01:00.000Z",
          direction: "inbound",
          text: "Check my next meeting",
        },
        memoryEntries: [],
      },
      undefined,
      executionObserver
    );

    expect(executeMock).toHaveBeenCalledWith({
      agentName: "calendar",
      callerContext: expect.objectContaining({
        callerPhone: "+15551234567",
      }),
      instructions: "Find the next meeting.",
    }, executionObserver);
  });
});
