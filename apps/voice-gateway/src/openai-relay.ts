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

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17";

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
  /** When true, audio is already PCM16 24kHz -- skip mulaw transcoding. */
  skipTranscoding?: boolean;
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
 * @param onAudioOut - Callback to send audio back to the caller (base64 encoded)
 * @param onClose - Callback invoked when the OpenAI connection closes
 * @returns Object with sendAudio() to forward incoming audio and close() to shut down
 */
export function createOpenAIRelay(
  config: RelayConfig,
  onAudioOut: (base64Audio: string) => void,
  onClose: () => void
): { sendAudio: (base64Payload: string) => void; close: () => void } {
  const {
    apiKey,
    session,
    imapClient,
    smtpConfig,
    supabase,
    toolApprovalConfig,
    memoryEntries,
    voicePreference,
    skipTranscoding,
  } = config;

  const systemPrompt = buildSystemPrompt(memoryEntries, toolApprovalConfig);
  let audioSendLogCount = 0;
  let sessionReady = false;
  const pendingAudio: string[] = [];

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  openaiWs.on("open", () => {
    console.log(`[relay] Connected to OpenAI Realtime API for session ${session.sessionId}`);

    // Configure the session — GA format for gpt-4o-mini-realtime-preview
    // Defaults: PCM16 24kHz, server_vad enabled
    const sessionConfig: Record<string, unknown> = {
      type: "realtime",
      instructions: systemPrompt,
      tools: toolDefinitions,
      tool_choice: "auto",
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: {
          voice: voicePreference || "alloy",
        },
      },
    };

    if (!skipTranscoding) {
      // Twilio path: override audio format to g711 ulaw 8kHz
      (sessionConfig.audio as any).input.format = { type: "audio/g711-ulaw", rate: 8000 };
      (sessionConfig.audio as any).output.format = { type: "audio/g711-ulaw", rate: 8000 };
    }

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: sessionConfig,
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

    if (event.type === "error") {
      console.error("[relay] OpenAI error:", JSON.stringify(event));
    }

    // Session is ready after session.updated — flush any queued audio
    if (event.type === "session.updated" && !sessionReady) {
      sessionReady = true;
      if (pendingAudio.length > 0) {
        console.log(`[relay] Flushing ${pendingAudio.length} queued audio packets`);
        for (const audio of pendingAudio) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        }
        pendingAudio.length = 0;
      }
    }

    // Handle audio output -- transcode to mulaw for Twilio, or pass through for browser
    // GA mini model uses "response.output_audio.delta"
    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      const audioEvent = event as { delta?: string };
      if (audioEvent.delta) {
        if (skipTranscoding) {
          onAudioOut(audioEvent.delta);
        } else {
          const pcm16Buffer = Buffer.from(audioEvent.delta, "base64");
          const mulawBuffer = pcm16_24kToMulaw(pcm16Buffer);
          onAudioOut(mulawBuffer.toString("base64"));
        }
      }
      return;
    }

    // Track assistant transcript (GA mini uses "response.output_audio_transcript.done")
    if (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") {
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
     * Receives audio, transcodes if needed, and sends to OpenAI.
     * For Twilio: decodes mulaw 8kHz -> PCM16 24kHz. For browser: passes through PCM16 24kHz.
     * @param base64Payload - Base64-encoded audio (mulaw for Twilio, PCM16 for browser)
     */
    sendAudio(base64Payload: string): void {
      let pcm16Base64: string;
      if (skipTranscoding) {
        pcm16Base64 = base64Payload;
      } else {
        const mulawBuffer = Buffer.from(base64Payload, "base64");
        const pcm16Buffer = mulawToPcm16_24k(mulawBuffer);
        pcm16Base64 = pcm16Buffer.toString("base64");
      }

      if (!sessionReady) {
        // Queue audio until session.updated fires
        pendingAudio.push(pcm16Base64);
        return;
      }

      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm16Base64,
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
