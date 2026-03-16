/**
 * Browser-based voice call page for debugging on localhost.
 *
 * Opens a direct WebSocket to the voice-gateway (no Twilio), captures mic
 * audio via AudioWorklet, and plays back assistant audio. Sends/receives
 * PCM16 24kHz audio as base64 JSON messages.
 *
 * Responsibilities:
 * - Authenticate with Supabase and pass JWT to voice-gateway
 * - Capture microphone audio using an AudioWorklet (capture-processor)
 * - Play assistant audio using an AudioWorklet (playback-processor)
 * - Manage WebSocket connection lifecycle
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { createBrowserClient } from "@/lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_GATEWAY_WS_URL =
  process.env.NEXT_PUBLIC_VOICE_GATEWAY_WS_URL ?? "ws://localhost:3001";

const VOICE_PIPELINE_URL =
  process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ?? "http://localhost:7860";

type CallBackend = "classic" | "pipeline";

// ============================================================================
// TYPES
// ============================================================================

/** Refs held during an active call session. */
interface CallSession {
  ws: WebSocket;
  audioContext: AudioContext;
  micStream: MediaStream;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Sets up AudioWorklet-based mic capture and playback.
 * @param audioContext - The AudioContext to use
 * @param micStream - The microphone MediaStream
 * @param ws - The WebSocket connection to the voice-gateway
 * @returns Cleanup function to disconnect audio nodes
 */
async function setupAudio(
  audioContext: AudioContext,
  micStream: MediaStream,
  ws: WebSocket
): Promise<() => void> {
  // Load worklet modules
  await audioContext.audioWorklet.addModule("/worklets/capture-processor.js");
  await audioContext.audioWorklet.addModule("/worklets/playback-processor.js");

  // Mic capture: MediaStream -> CaptureProcessor -> sends PCM16 over WS
  const micSource = audioContext.createMediaStreamSource(micStream);
  const captureNode = new AudioWorkletNode(audioContext, "capture-processor");

  captureNode.port.onmessage = (event: MessageEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Convert ArrayBuffer to base64
    const pcm16 = new Uint8Array(event.data);
    const base64 = arrayBufferToBase64(pcm16);
    ws.send(JSON.stringify({ type: "audio", data: base64 }));
  };

  micSource.connect(captureNode);
  // Connect to destination to keep the processor alive (output is silent)
  captureNode.connect(audioContext.destination);

  // Playback: receives PCM16 from WS -> PlaybackProcessor -> speaker
  const playbackNode = new AudioWorkletNode(audioContext, "playback-processor");
  playbackNode.connect(audioContext.destination);

  // Route incoming audio from WebSocket to playback processor
  const handleWsMessage = (event: MessageEvent) => {
    let message: { type: string; data?: string };
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (message.type === "audio" && message.data) {
      const pcm16 = base64ToArrayBuffer(message.data);
      console.log(`[playback] received ${pcm16.byteLength} bytes`);
      playbackNode.port.postMessage(pcm16, [pcm16]);
    }
  };

  ws.addEventListener("message", handleWsMessage);

  return () => {
    ws.removeEventListener("message", handleWsMessage);
    micSource.disconnect();
    captureNode.disconnect();
    playbackNode.disconnect();
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<CallBackend>("classic");
  const [pipelineIframeUrl, setPipelineIframeUrl] = useState<string | null>(null);

  const sessionRef = useRef<CallSession | null>(null);
  const cleanupAudioRef = useRef<(() => void) | null>(null);

  /**
   * Starts a pipeline call by building the iframe URL with the user's JWT.
   * The Pipecat server serves a WebRTC client at /client.
   */
  const startPipelineCall = useCallback(async () => {
    setError(null);
    setStatus("Connecting to pipeline...");

    try {
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw new Error("Not authenticated. Please sign in first.");
      }
      const token = sessionData.session.access_token;

      const url = `${VOICE_PIPELINE_URL}/client?token=${encodeURIComponent(token)}`;
      setPipelineIframeUrl(url);
      setCallActive(true);
      setStatus("Pipeline call active");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start pipeline call";
      setError(msg);
      setStatus("Ready");
    }
  }, []);

  /** Stops the pipeline call by removing the iframe. */
  const endPipelineCall = useCallback(() => {
    setPipelineIframeUrl(null);
    setCallActive(false);
    setStatus("Ready");
  }, []);

  const startCall = useCallback(async () => {
    setError(null);
    setStatus("Connecting...");

    try {
      // Get Supabase access token
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw new Error("Not authenticated. Please sign in first.");
      }
      const token = sessionData.session.access_token;

      // Request microphone access
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Open WebSocket to voice-gateway
      const ws = new WebSocket(
        `${VOICE_GATEWAY_WS_URL}/browser-stream?token=${encodeURIComponent(token)}`
      );

      const audioContext = new AudioContext({ sampleRate: 48000 });
      await audioContext.resume();

      ws.onopen = async () => {
        setStatus("Connected - setting up audio...");
        try {
          cleanupAudioRef.current = await setupAudio(audioContext, micStream, ws);
          setStatus("Call active");
          setCallActive(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Audio setup failed";
          setError(msg);
          ws.close();
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection failed. Is the voice-gateway running?");
        setStatus("Ready");
      };

      ws.onclose = () => {
        setCallActive(false);
        setStatus("Ready");
        cleanup();
      };

      sessionRef.current = { ws, audioContext, micStream };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start call";
      setError(msg);
      setStatus("Ready");
    }
  }, []);

  const endCall = useCallback(() => {
    cleanup();
    setCallActive(false);
    setStatus("Ready");
  }, []);

  /** Tears down WebSocket, audio context, and mic stream. */
  function cleanup() {
    if (cleanupAudioRef.current) {
      cleanupAudioRef.current();
      cleanupAudioRef.current = null;
    }

    const session = sessionRef.current;
    if (!session) return;

    if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
      session.ws.close();
    }

    session.audioContext.close();
    session.micStream.getTracks().forEach((track) => track.stop());
    sessionRef.current = null;
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  /** Dispatches start/end based on the selected backend. */
  const handleStart = backend === "pipeline" ? startPipelineCall : startCall;
  const handleEnd = backend === "pipeline" ? endPipelineCall : endCall;

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Browser Call</h1>

      {/* Backend toggle -- disabled while a call is active */}
      <div className="mb-4 flex items-center gap-3">
        <span className="text-sm font-medium text-gray-700">Backend:</span>
        <button
          onClick={() => setBackend("classic")}
          disabled={callActive}
          className={`rounded-md px-4 py-1.5 text-sm font-medium ${
            backend === "classic"
              ? "bg-gray-900 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          } disabled:opacity-50`}
        >
          Classic
        </button>
        <button
          onClick={() => setBackend("pipeline")}
          disabled={callActive}
          className={`rounded-md px-4 py-1.5 text-sm font-medium ${
            backend === "pipeline"
              ? "bg-gray-900 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          } disabled:opacity-50`}
        >
          Pipeline
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <p className="mb-4 text-sm text-gray-500">
          {backend === "classic"
            ? "Direct voice connection to the assistant via your browser microphone. For localhost debugging -- bypasses Twilio."
            : "Voice connection via the Pipecat pipeline (Deepgram STT + OpenRouter LLM + Deepgram TTS). Uses WebRTC."}
        </p>

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">{status}</span>

          {!callActive ? (
            <button
              onClick={handleStart}
              className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Start Call
            </button>
          ) : (
            <button
              onClick={handleEnd}
              className="rounded-md bg-red-600 px-6 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              End Call
            </button>
          )}
        </div>

        {/* Pipeline iframe -- a proper WebRTC client component can replace this later */}
        {backend === "pipeline" && pipelineIframeUrl && (
          <iframe
            src={pipelineIframeUrl}
            allow="microphone"
            className="mt-4 h-[500px] w-full rounded-md border border-gray-200"
          />
        )}
      </section>
    </div>
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts a Uint8Array to a base64 string.
 * @param bytes - The byte array to encode
 * @returns Base64-encoded string
 */
function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a base64 string to an ArrayBuffer.
 * @param base64 - The base64-encoded string
 * @returns ArrayBuffer with decoded bytes
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
