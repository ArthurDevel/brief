import { describe, expect, it, vi } from "vitest";
import { VoiceOpenPokeNarrationAgentRuntime } from "../openpoke/narrationAgent.js";
import type { OpenRouterTextClient } from "../openpoke/openRouterClient.js";

describe("VoiceOpenPokeNarrationAgentRuntime", () => {
  it("returns one short narration sentence", async () => {
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content: "I'm checking that now. I will let you know soon.",
        toolCalls: [],
      }),
    };
    const runtime = new VoiceOpenPokeNarrationAgentRuntime(openRouterClient);

    const result = await runtime.generateNarration({
      activeExecution: {
        agentName: "calendar",
        currentToolName: "GOOGLECALENDAR_LIST_EVENTS",
        executionId: "calendar:1",
        instructions: "Find the next meeting.",
        recentMessages: [
          "Latest execution note: Looking for the next upcoming meeting.",
          "Tool GOOGLECALENDAR_LIST_EVENTS finished with status success.",
        ],
        startedAt: "2026-04-23T10:00:00.000Z",
        status: "running_tool",
        updatedAt: "2026-04-23T10:00:02.000Z",
      },
      previousNarration: null,
    });

    expect(result).toEqual({
      createdAt: expect.any(String),
      message: "I'm checking that now.",
    });
  });

  it("returns null when the narrator chooses to skip", async () => {
    const openRouterClient: OpenRouterTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content: "SKIP",
        toolCalls: [],
      }),
    };
    const runtime = new VoiceOpenPokeNarrationAgentRuntime(openRouterClient);

    const result = await runtime.generateNarration({
      activeExecution: {
        agentName: "calendar",
        currentToolName: null,
        executionId: "calendar:1",
        instructions: "Find the next meeting.",
        recentMessages: [],
        startedAt: "2026-04-23T10:00:00.000Z",
        status: "planning",
        updatedAt: "2026-04-23T10:00:01.000Z",
      },
      previousNarration: "I'm checking that now.",
    });

    expect(result).toBeNull();
  });
});
