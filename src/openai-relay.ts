/**
 * OpenAI Realtime API WebSocket relay.
 *
 * Manages a single WebSocket connection to the OpenAI Realtime API,
 * configures the session with tools and voice settings, intercepts
 * tool calls to execute them server-side, and forwards audio/transcript
 * events to a callback.
 *
 * Responsibilities:
 * - Opens and manages the OpenAI Realtime WebSocket connection
 * - Sends session.update with tools, instructions, and voice config
 * - Intercepts function_call items and executes mock tool handlers
 * - Forwards audio and transcript events to the browser via callback
 * - Logs transcripts to the server console
 */

import WebSocket from "ws";
import { tools } from "./tools.js";
import type { Tool, OutputItemDoneEvent, FunctionCallItem } from "./types.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

const SYSTEM_INSTRUCTIONS = `You are a helpful voice email assistant. The user is calling you on the phone to manage their email inbox.

IMPORTANT: Always respond in English, regardless of what language you think you hear. Never switch to another language.

You have access to tools to list, read, draft, delete, archive, and send emails. Use them whenever the user asks about their inbox or wants to take action on an email.

Speak fast and be brief. Use short sentences. No filler words. Get to the point immediately. When listing emails, just say the sender and subject in quick succession. When reading an email, summarize the key points only.

Always confirm before destructive actions like deleting or sending emails.`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the tool handler lookup map from the tools array.
 * @param toolList - Array of Tool definitions with handlers
 * @returns Map from tool name to handler function
 */
function buildToolHandlerMap(toolList: Tool[]): Map<string, Tool["handler"]> {
  const map = new Map<string, Tool["handler"]>();
  for (const tool of toolList) {
    map.set(tool.definition.name, tool.handler);
  }
  return map;
}

/**
 * Handles a function call from OpenAI by executing the mock tool handler
 * and sending the result back to OpenAI.
 * @param item - The function call item from OpenAI
 * @param openaiWs - The OpenAI WebSocket connection
 * @param handlerMap - Map from tool name to handler function
 */
function handleFunctionCall(
  item: FunctionCallItem,
  openaiWs: WebSocket,
  handlerMap: Map<string, Tool["handler"]>,
  onBrowserEvent: (event: string) => void
): void {
  const handler = handlerMap.get(item.name);
  if (!handler) {
    console.error(`[relay] Unknown tool: ${item.name}`);
    return;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    console.error(`[relay] Failed to parse arguments for ${item.name}: ${item.arguments}`);
    args = {};
  }

  console.log(`[tool] ${item.name}(${JSON.stringify(args)})`);
  const result = handler(args);
  console.log(`[tool] -> ${result}`);

  // Notify the browser about the tool call
  onBrowserEvent(
    JSON.stringify({
      type: "tool_call",
      name: item.name,
      arguments: args,
      result: JSON.parse(result),
    })
  );

  // Send the tool result back to OpenAI
  openaiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: result,
      },
    })
  );

  // Tell OpenAI to continue responding with the tool result
  openaiWs.send(JSON.stringify({ type: "response.create" }));
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Creates a relay connection to the OpenAI Realtime API.
 * @param apiKey - OpenAI API key
 * @param onEvent - Callback invoked for every event that should be forwarded to the browser
 * @param onClose - Callback invoked when the OpenAI connection closes
 * @returns Object with send() to forward browser messages and close() to shut down
 */
export function createOpenAIRelay(
  apiKey: string,
  onEvent: (event: string) => void,
  onClose: () => void
): { send: (message: string) => void; close: () => void } {
  const handlerMap = buildToolHandlerMap(tools);

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("[relay] Connected to OpenAI Realtime API");

    // Configure the session
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: SYSTEM_INSTRUCTIONS,
          voice: "ash",
          modalities: ["text", "audio"],
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          tools: tools.map((t) => t.definition),
        },
      })
    );
  });

  openaiWs.on("message", (data) => {
    const raw = data.toString();
    let event: { type: string; [key: string]: unknown };

    try {
      event = JSON.parse(raw);
    } catch {
      console.error("[relay] Failed to parse OpenAI event");
      return;
    }

    // Log transcripts to console
    if (event.type === "response.audio_transcript.delta") {
      const delta = event as { delta?: string };
      if (delta.delta) process.stdout.write(delta.delta);
    }

    if (event.type === "response.audio_transcript.done") {
      console.log(""); // newline after transcript
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = event as { transcript?: string };
      console.log(`[user] ${transcript.transcript}`);
    }

    // Intercept tool calls -- handle server-side, don't forward to browser
    if (event.type === "response.output_item.done") {
      const outputEvent = event as unknown as OutputItemDoneEvent;
      if (outputEvent.item.type === "function_call") {
        handleFunctionCall(outputEvent.item as FunctionCallItem, openaiWs, handlerMap, onEvent);
        return;
      }
    }

    // Forward everything else to the browser
    onEvent(raw);
  });

  openaiWs.on("error", (err) => {
    console.error("[relay] OpenAI WebSocket error:", err.message);
  });

  openaiWs.on("close", () => {
    console.log("[relay] OpenAI connection closed");
    onClose();
  });

  return {
    /**
     * Forward a message from the browser to OpenAI.
     * @param message - Raw JSON string from the browser WebSocket
     */
    send(message: string): void {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(message);
      }
    },

    /** Close the OpenAI connection. */
    close(): void {
      if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
        openaiWs.close();
      }
    },
  };
}
