import { describe, expect, it } from "vitest";
import { postProcessExecutionToolResultData } from "../executionToolResultFormatter.js";

describe("postProcessExecutionToolResultData", () => {
  it("shrinks direct Gmail fetch results to compact message summaries", () => {
    const result = postProcessExecutionToolResultData({
      toolArguments: {
        max_results: 10,
        query: "in:inbox",
      },
      toolName: "GMAIL_FETCH_EMAILS",
      toolResultData: {
        messages: [
          {
            display_url: "https://mail.google.com/mail/u/0/#inbox/abc",
            labelIds: ["UNREAD", "INBOX"],
            messageId: "message-1",
            messageText:
              "Hello there.\n\nThis email body is much longer than the preview we want to keep in memory.",
            messageTimestamp: "2026-04-27T09:00:00.000Z",
            payload: {
              headers: [
                {
                  name: "From",
                  value: "Alice <alice@example.com>",
                },
                {
                  name: "Subject",
                  value: "Quarterly update",
                },
              ],
            },
            threadId: "thread-1",
          },
        ],
        resultSizeEstimate: 1,
      },
    });

    expect(result).toEqual({
      messages: [
        {
          id: "message-1",
          labels: ["INBOX"],
          preview:
            "Hello there. This email body is much longer than the preview we want to keep in memory.",
          receivedAt: "2026-04-27T09:00:00.000Z",
          sender: "Alice <alice@example.com>",
          subject: "Quarterly update",
          threadId: "thread-1",
          unread: true,
          url: "https://mail.google.com/mail/u/0/#inbox/abc",
        },
      ],
      resultSizeEstimate: 1,
    });
  });

  it("shrinks Gmail results nested inside COMPOSIO_MULTI_EXECUTE_TOOL", () => {
    const result = postProcessExecutionToolResultData({
      toolArguments: {
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
      toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
      toolResultData: {
        results: [
          {
            index: 0,
            response: {
              data: {
                messages: [
                  {
                    messageId: "message-2",
                    messageText:
                      "<html><body>Large HTML body that should not survive replay.</body></html>",
                    payload: {
                      headers: [
                        {
                          name: "From",
                          value: "Bob <bob@example.com>",
                        },
                        {
                          name: "Subject",
                          value: "Inbox item",
                        },
                      ],
                    },
                    preview: {
                      body: "Short preview from Gmail.",
                    },
                    threadId: "thread-2",
                  },
                ],
              },
              successful: true,
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      results: [
        {
          index: 0,
          response: {
            data: {
              messages: [
                {
                  id: "message-2",
                  labels: [],
                  preview: "Short preview from Gmail.",
                  receivedAt: null,
                  sender: "Bob <bob@example.com>",
                  subject: "Inbox item",
                  threadId: "thread-2",
                  unread: false,
                  url: null,
                },
              ],
              resultSizeEstimate: 1,
            },
            successful: true,
          },
          toolSlug: "GMAIL_FETCH_EMAILS",
        },
      ],
    });
  });

  it("reduces a full Gmail message fetch to readable email text", () => {
    const result = postProcessExecutionToolResultData({
      toolArguments: {
        format: "full",
        message_id: "message-3",
      },
      toolName: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      toolResultData: {
        messageId: "message-3",
        messageText:
          "<html><body><h1>Status</h1><p>Hello team,</p><p>The project is on track.</p></body></html>",
        payload: {
          mimeType: "text/html",
        },
      },
    });

    expect(result).toBe("Status\nHello team,\nThe project is on track.");
  });

  it("reduces a nested full Gmail message fetch inside COMPOSIO_MULTI_EXECUTE_TOOL", () => {
    const encodedPlainText = Buffer.from(
      "Hello team,\n\nThis is the full plain-text email body.",
      "utf8"
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const result = postProcessExecutionToolResultData({
      toolArguments: {
        tools: [
          {
            arguments: {
              format: "full",
              message_id: "message-4",
            },
            tool_slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
          },
        ],
      },
      toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
      toolResultData: {
        results: [
          {
            index: 0,
            response: {
              data: {
                messageId: "message-4",
                payload: {
                  parts: [
                    {
                      body: {
                        data: encodedPlainText,
                      },
                      mimeType: "text/plain",
                    },
                  ],
                },
              },
              successful: true,
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      results: [
        {
          index: 0,
          response: {
            data: "Hello team,\n\nThis is the full plain-text email body.",
            successful: true,
          },
          toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        },
      ],
    });
  });
});
