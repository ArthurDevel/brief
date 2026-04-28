import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmTextClient } from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLlmTextClient", () => {
  it("uses the OpenRouter endpoint and parses tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Checking now.",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"query\":\"urgent\"}",
                      name: "SEARCH_EMAIL",
                    },
                    id: "tool_1",
                  },
                ],
              },
            },
          ],
          model: "google/gemini-3-flash-preview",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmTextClient({
      apiKey: "openrouter-key",
      model: "google/gemini-3-flash-preview",
      provider: "openrouter",
    });

    const response = await client.createChatCompletion({
      messages: [
        {
          content: "Check my inbox",
          role: "user",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer openrouter-key",
          "Content-Type": "application/json",
        },
      })
    );
    expect(response).toEqual({
      content: "Checking now.",
      toolCalls: [
        {
          arguments: {
            query: "urgent",
          },
          id: "tool_1",
          name: "SEARCH_EMAIL",
        },
      ],
    });
  });

  it("uses the Cerebras endpoint and returns plain assistant text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "All set.",
              },
            },
          ],
          model: "llama-3.3-70b",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmTextClient({
      apiKey: "cerebras-key",
      model: "llama-3.3-70b",
      provider: "cerebras",
    });

    const response = await client.createChatCompletion({
      messages: [
        {
          content: "Say hi",
          role: "user",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cerebras.ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer cerebras-key",
          "Content-Type": "application/json",
        },
      })
    );
    expect(response).toEqual({
      content: "All set.",
      toolCalls: [],
    });
  });

  it("serializes fallback tool call ids when replaying assistant tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Done.",
              },
            },
          ],
          model: "llama-3.3-70b",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmTextClient({
      apiKey: "cerebras-key",
      model: "llama-3.3-70b",
      provider: "cerebras",
    });

    await client.createChatCompletion({
      messages: [
        {
          content: "Checking tools.",
          role: "assistant",
          toolCalls: [
            {
              arguments: {
                query: "urgent",
              },
              id: null,
              name: "GMAIL_FETCH_EMAILS",
            },
          ],
        },
        {
          content: "{\"status\":\"success\"}",
          role: "tool",
          toolCallId: "GMAIL_FETCH_EMAILS",
        },
      ],
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(requestBody.messages[0].tool_calls[0].id).toBe("GMAIL_FETCH_EMAILS");
    expect(requestBody.messages[1].tool_call_id).toBe("GMAIL_FETCH_EMAILS");
  });
});
