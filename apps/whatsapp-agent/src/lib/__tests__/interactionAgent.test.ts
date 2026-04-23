import { describe, expect, it, vi } from "vitest";
import { VoiceOpenPokeInteractionAgentRuntime } from "../openpoke/interactionAgent.js";
import {
  buildVoiceOpenPokeInteractionSystemPrompt,
  buildVoiceOpenPokeInteractionUserPrompt,
} from "../openpoke/promptBuilder.js";
import type { OpenRouterTextClient } from "../openpoke/openRouterClient.js";
import type { VoiceOpenPokeExecutionAgent } from "../openpoke/executionAgent.js";
import { getDefaultWhatsAppVoiceConfig } from "../whatsappVoice.js";

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

describe("VoiceOpenPokeInteractionAgentRuntime", () => {
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
    });
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
});
