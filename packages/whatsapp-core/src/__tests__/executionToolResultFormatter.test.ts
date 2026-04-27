import { describe, expect, it } from "vitest";
import { postProcessExecutionToolResultData } from "../executionToolResultFormatter.js";

// ============================================================================
// TESTS
// ============================================================================

describe("postProcessExecutionToolResultData", () => {
  it("marks COMPOSIO_SEARCH_WEB output as summary data that needs source fetching for specifics", () => {
    const result = postProcessExecutionToolResultData("COMPOSIO_SEARCH_WEB", {
      answer: "The train appears to depart at 21:05.",
      citations: [
        {
          title: "Official source",
          url: "https://example.com/source",
        },
      ],
    });

    expect(result).toMatchObject({
      answer: "The train appears to depart at 21:05.",
      sourceVerification: {
        citationUrls: ["https://example.com/source"],
        fetchTool: "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
        requiredWhen: "the current task requires specific information from a source",
        searchResultType: "summary",
      },
    });
    expect(JSON.stringify(result)).toContain(
      "If the current task requires specific information from a source"
    );
  });

  it("recursively marks COMPOSIO_SEARCH_WEB output inside COMPOSIO_MULTI_EXECUTE_TOOL", () => {
    const result = postProcessExecutionToolResultData(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      {
        results: [
          {
            index: 0,
            response: {
              data: {
                answer: "A summarized search answer.",
                citations: [
                  {
                    title: "Source",
                    url: "https://example.com/nested-source",
                  },
                ],
              },
              successful: true,
            },
          },
        ],
      },
      {
        tools: [
          {
            tool_slug: "COMPOSIO_SEARCH_WEB",
            arguments: {
              query: "specific information query",
            },
          },
        ],
      }
    );

    expect(result).toMatchObject({
      results: [
        {
          response: {
            data: {
              answer: "A summarized search answer.",
              sourceVerification: {
                citationUrls: ["https://example.com/nested-source"],
                fetchTool: "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
              },
            },
            successful: true,
          },
        },
      ],
    });
  });

  it("keeps Gmail fetch results compact", () => {
    const result = postProcessExecutionToolResultData("GMAIL_FETCH_EMAILS", {
      messages: [
        {
          labelIds: ["INBOX", "UNREAD"],
          messageId: "message-1",
          messageText: "Hello\n\nthere",
          messageTimestamp: "2026-04-27T00:00:00.000Z",
          payload: {
            headers: [
              {
                name: "From",
                value: "sender@example.com",
              },
              {
                name: "Subject",
                value: "Test subject",
              },
            ],
          },
          threadId: "thread-1",
        },
      ],
      resultSizeEstimate: 1,
    });

    expect(result).toEqual({
      messages: [
        {
          id: "message-1",
          labels: ["INBOX"],
          preview: "Hello there",
          receivedAt: "2026-04-27T00:00:00.000Z",
          sender: "sender@example.com",
          subject: "Test subject",
          threadId: "thread-1",
          unread: true,
          unsupportedAttachments: undefined,
          url: undefined,
        },
      ],
      nextPageToken: undefined,
      resultSizeEstimate: 1,
    });
  });
});
