/**
 * OpenAI Realtime API WebSocket relay for Twilio media streams.
 *
 * Manages a single WebSocket connection to the OpenAI Realtime API,
 * configures the session with user-specific prompt and tools, routes
 * tool calls through the action queue, and handles bidirectional audio
 * transcoding between Twilio (mulaw 8kHz) and OpenAI (PCM16 24kHz).
 *
 * Responsibilities:
 * - Opens and manages the OpenAI Realtime WebSocket connection
 * - Sends session.update with tools, user-specific instructions, and voice config
 * - Intercepts function_call items and routes through @dublin/tools action queue
 * - Transcodes audio between Twilio mulaw and OpenAI PCM16 formats
 * - Tracks transcripts and token usage on the active session
 * - Handles IMAP errors gracefully with friendly error messages
 */

import WebSocket from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImapFlow } from "imapflow";
import type { SmtpConfig } from "@dublin/email";
import { toolDefinitions, handleToolCall } from "@dublin/tools";
import type { ToolName, ToolApprovalConfig } from "@dublin/tools";
import { buildSystemPrompt } from "./prompt-builder.js";
import { mulawToPcm16_24k, pcm16_24kToMulaw } from "./audio-transcoder.js";
import type { ActiveSession } from "./session-manager.js";
import { addTranscriptEntry, addTokenUsage } from "./session-manager.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for creating an OpenAI relay. */
export interface RelayConfig {
  apiKey: string;
  session: ActiveSession;
  imapClient: ImapFlow;
  smtpConfig: SmtpConfig;
  supabase: SupabaseClient;
  toolApprovalConfig: ToolApprovalConfig;
  memoryEntries: { key: string; value: string }[];
  voicePreference: string;
}

/** A function call item returned by OpenAI in response.output_item.done. */
interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** The response.output_item.done server event. */
interface OutputItemDoneEvent {
  type: "response.output_item.done";
  item: FunctionCallItem | { type: string };
}

/** Token usage from a response.done event. */
interface ResponseDoneEvent {
  type: "response.done";
  response: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Creates a relay connection to the OpenAI Realtime API for a Twilio media stream.
 * Handles audio transcoding, tool call routing, transcript tracking, and token usage.
 * @param config - Full relay configuration including user context and session
 * @param onTwilioAudio - Callback to send mulaw audio back to Twilio (base64 encoded)
 * @param onClose - Callback invoked when the OpenAI connection closes
 * @returns Object with sendTwilioAudio() to forward Twilio audio and close() to shut down
 */
export function createOpenAIRelay(
  config: RelayConfig,
  onTwilioAudio: (base64Audio: string) => void,
  onClose: () => void
): { sendTwilioAudio: (base64MulawPayload: string) => void; close: () => void } {
  const {
    apiKey,
    session,
    imapClient,
    smtpConfig,
    supabase,
    toolApprovalConfig,
    memoryEntries,
    voicePreference,
  } = config;

  const systemPrompt = buildSystemPrompt(memoryEntries, toolApprovalConfig);

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log(`[relay] Connected to OpenAI Realtime API for session ${session.sessionId}`);

    // Configure the session with user-specific prompt and tools
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: systemPrompt,
          voice: voicePreference,
          modalities: ["text", "audio"],
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          tools: toolDefinitions,
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

    // Handle audio output -- transcode PCM16 24kHz to mulaw and send to Twilio
    if (event.type === "response.audio.delta") {
      const audioEvent = event as { delta?: string };
      if (audioEvent.delta) {
        const pcm16Buffer = Buffer.from(audioEvent.delta, "base64");
        const mulawBuffer = pcm16_24kToMulaw(pcm16Buffer);
        onTwilioAudio(mulawBuffer.toString("base64"));
      }
      return;
    }

    // Track assistant transcript
    if (event.type === "response.audio_transcript.done") {
      const transcriptEvent = event as { transcript?: string };
      if (transcriptEvent.transcript) {
        console.log(`[assistant] ${transcriptEvent.transcript}`);
        addTranscriptEntry(session, {
          role: "assistant",
          text: transcriptEvent.transcript,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Track user transcript
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcriptEvent = event as { transcript?: string };
      if (transcriptEvent.transcript) {
        console.log(`[user] ${transcriptEvent.transcript}`);
        addTranscriptEntry(session, {
          role: "user",
          text: transcriptEvent.transcript,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Track token usage from response.done events
    if (event.type === "response.done") {
      const responseEvent = event as unknown as ResponseDoneEvent;
      const usage = responseEvent.response?.usage;
      if (usage) {
        addTokenUsage(session, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      }
    }

    // Intercept tool calls -- route through action queue
    if (event.type === "response.output_item.done") {
      const outputEvent = event as unknown as OutputItemDoneEvent;
      if (outputEvent.item.type === "function_call") {
        const functionCall = outputEvent.item as FunctionCallItem;
        handleFunctionCallAsync(
          functionCall,
          openaiWs,
          session,
          imapClient,
          smtpConfig,
          supabase,
          toolApprovalConfig
        );
        return;
      }
    }
  });

  openaiWs.on("error", (err) => {
    console.error("[relay] OpenAI WebSocket error:", err.message);
  });

  openaiWs.on("close", () => {
    console.log(`[relay] OpenAI connection closed for session ${session.sessionId}`);
    onClose();
  });

  return {
    /**
     * Receives mulaw audio from Twilio, transcodes to PCM16 24kHz, and sends to OpenAI.
     * @param base64MulawPayload - Base64-encoded mulaw audio from Twilio media event
     */
    sendTwilioAudio(base64MulawPayload: string): void {
      if (openaiWs.readyState !== WebSocket.OPEN) return;

      const mulawBuffer = Buffer.from(base64MulawPayload, "base64");
      const pcm16Buffer = mulawToPcm16_24k(mulawBuffer);

      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm16Buffer.toString("base64"),
        })
      );
    },

    /** Close the OpenAI connection. */
    close(): void {
      if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
        openaiWs.close();
      }
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Handles a function call from OpenAI asynchronously.
 * Routes through the action queue, sends result back to OpenAI.
 * On IMAP/execution errors, sends a friendly error message as the function output.
 * @param item - The function call item from OpenAI
 * @param openaiWs - The OpenAI WebSocket connection
 * @param session - Active session for tracking
 * @param imapClient - Connected ImapFlow client
 * @param smtpConfig - SMTP configuration
 * @param supabase - Supabase client
 * @param toolApprovalConfig - User's tool approval overrides
 */
async function handleFunctionCallAsync(
  item: FunctionCallItem,
  openaiWs: WebSocket,
  session: ActiveSession,
  imapClient: ImapFlow,
  smtpConfig: SmtpConfig,
  supabase: SupabaseClient,
  toolApprovalConfig: ToolApprovalConfig
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    console.error(`[relay] Failed to parse arguments for ${item.name}: ${item.arguments}`);
    args = {};
  }

  console.log(`[tool] ${item.name}(${JSON.stringify(args)})`);

  let output: string;
  try {
    const result = await handleToolCall(
      {
        userId: session.userId,
        sessionId: session.sessionId,
        toolName: item.name as ToolName,
        arguments: args,
      },
      toolApprovalConfig,
      imapClient,
      smtpConfig,
      supabase
    );

    console.log(`[tool] -> ${result.status}: ${result.message}`);
    output = JSON.stringify(result);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`[tool] Error executing ${item.name}: ${errorMessage}`);
    output = JSON.stringify({
      error: true,
      message: `Sorry, there was a problem with that action: ${errorMessage}`,
    });
  }

  // Send the tool result back to OpenAI
  if (openaiWs.readyState !== WebSocket.OPEN) return;

  openaiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output,
      },
    })
  );

  // Tell OpenAI to continue responding with the tool result
  openaiWs.send(JSON.stringify({ type: "response.create" }));
}
