import { describe, expect, it, vi } from "vitest";
import { mapSessionToolsToLiveKitTools } from "../composio.js";

describe("mapSessionToolsToLiveKitTools", () => {
  it("registers local tools by the Composio session tool name and executes through the session", async () => {
    const executeMock = vi.fn().mockResolvedValue({
      data: {
        ok: true,
      },
      error: null,
      successful: true,
    });

    const tools = mapSessionToolsToLiveKitTools(
      [
        {
          type: "function",
          function: {
            name: "LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE",
            description: "Send a WhatsApp auth template.",
            parameters: {
              type: "object",
              properties: {
                toolkit: {
                  type: "string",
                },
              },
              required: ["toolkit"],
            },
          },
        },
      ],
      {
        tools: {
          executeMetaTool: vi.fn(),
        },
      } as never,
      {
        sessionId: "session_123",
        execute: executeMock,
      }
    );

    expect(Object.keys(tools)).toEqual(["LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE"]);

    const result = await tools.LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE.execute(
      { toolkit: "notion" },
      {
        ctx: {} as never,
        toolCallId: "tool_call_1",
      }
    );

    expect(executeMock).toHaveBeenCalledWith("LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE", {
      toolkit: "notion",
    });
    expect(result).toBe("{\"ok\":true}");
  });

  it("executes Composio meta tools through executeMetaTool with the session id", async () => {
    const executeMetaToolMock = vi.fn().mockResolvedValue({
      data: {
        successful: true,
      },
      error: null,
      successful: true,
    });

    const tools = mapSessionToolsToLiveKitTools(
      [
        {
          type: "function",
          function: {
            name: "COMPOSIO_SEARCH_TOOLS",
            description: "Search for tools.",
            parameters: {
              type: "object",
              properties: {
                queries: {
                  type: "array",
                },
              },
            },
          },
        },
      ],
      {
        tools: {
          executeMetaTool: executeMetaToolMock,
        },
      } as never,
      {
        sessionId: "session_abc",
        execute: vi.fn(),
      }
    );

    const result = await tools.COMPOSIO_SEARCH_TOOLS.execute(
      {
        queries: [{ use_case: "find notion page" }],
        session: { generate_id: true },
      },
      {
        ctx: {} as never,
        toolCallId: "tool_call_meta_1",
      }
    );

    expect(executeMetaToolMock).toHaveBeenCalledWith("COMPOSIO_SEARCH_TOOLS", {
      sessionId: "session_abc",
      arguments: {
        queries: [{ use_case: "find notion page" }],
        session: { generate_id: true },
      },
    });
    expect(result).toBe("{\"successful\":true}");
  });
});
