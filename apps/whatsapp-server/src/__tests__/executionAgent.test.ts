import { describe, expect, it, vi } from "vitest";
import { WhatsAppTextExecutionAgentRuntime } from "../text/executionAgent.js";
import type { OpenRouterTextClient } from "../text/openRouterClient.js";

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

// ============================================================================
// TESTS
// ============================================================================

describe("WhatsAppTextExecutionAgentRuntime", () => {
  it("returns a summarized failure when the execution loop reaches the iteration limit", async () => {
    const executionClient: OpenRouterTextClient = {
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
    const summarizerClient: OpenRouterTextClient = {
      createChatCompletion: vi.fn().mockResolvedValue({
        content:
          "The agent repeatedly searched Gmail-related tools but never produced a final inbox summary, so the task stopped after hitting the execution iteration limit.",
        toolCalls: [],
      }),
    };
    const runtime = new WhatsAppTextExecutionAgentRuntime(
      executionClient,
      summarizerClient,
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
