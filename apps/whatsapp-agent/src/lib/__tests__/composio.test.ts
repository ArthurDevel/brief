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

  it("shrinks Gmail fetch payloads returned by Composio tools", async () => {
    const executeMock = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            display_url: "https://mail.google.com/mail/u/0/#inbox/abc",
            labelIds: ["UNREAD", "INBOX"],
            messageId: "message-1",
            messageText:
              "<html><body>This email body is much larger than what the voice agent should keep.</body></html>",
            payload: {
              headers: [
                {
                  name: "From",
                  value: "Alex <alex@example.com>",
                },
                {
                  name: "To",
                  value: "team@example.com",
                },
                {
                  name: "Subject",
                  value: "Inbox summary",
                },
              ],
            },
            threadId: "thread-1",
          },
        ],
      },
      error: null,
      successful: true,
    });

    const tools = mapSessionToolsToLiveKitTools(
      [
        {
          type: "function",
          function: {
            name: "GMAIL_FETCH_EMAILS",
            description: "Fetch Gmail messages.",
            parameters: {
              type: "object",
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

    const result = await tools.GMAIL_FETCH_EMAILS.execute(
      {
        max_results: 5,
        query: "in:inbox",
      },
      {
        ctx: {} as never,
        toolCallId: "tool_call_gmail_1",
      }
    );

    expect(executeMock).toHaveBeenCalledWith("GMAIL_FETCH_EMAILS", {
      max_results: 5,
      query: "in:inbox",
    });
    expect(JSON.parse(result)).toEqual({
      messages: [
        {
          from: "Alex <alex@example.com>",
          id: "message-1",
          labels: ["INBOX"],
          preview:
            "This email body is much larger than what the voice agent should keep.",
          receivedAt: null,
          subject: "Inbox summary",
          threadId: "thread-1",
          to: "team@example.com",
          unread: true,
          url: "https://mail.google.com/mail/u/0/#inbox/abc",
        },
      ],
      resultSizeEstimate: 1,
    });
    expect(result).not.toContain("messageText");
  });

  it("returns plain text when Gmail attachments are unsupported", async () => {
    const executeMock = vi.fn().mockResolvedValue({
      data: {
        file: {
          s3url: "https://example.com/file.pdf",
        },
      },
      error: null,
      successful: true,
    });

    const tools = mapSessionToolsToLiveKitTools(
      [
        {
          type: "function",
          function: {
            name: "GMAIL_GET_ATTACHMENT",
            description: "Fetch one Gmail attachment.",
            parameters: {
              type: "object",
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

    const result = await tools.GMAIL_GET_ATTACHMENT.execute(
      {
        attachment_id: "attachment-1",
        message_id: "message-1",
      },
      {
        ctx: {} as never,
        toolCallId: "tool_call_attachment_1",
      }
    );

    expect(result).toBe("attachments not supported yet");
  });
});
