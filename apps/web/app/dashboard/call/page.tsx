/**
 * Browser-based voice call page for debugging on localhost.
 *
 * Supports two backends:
 * - "Classic": direct WebSocket to the voice-gateway with AudioWorklet-based
 *   PCM16 capture/playback.
 * - "Pipeline": WebRTC connection to the Pipecat voice-pipeline server
 *   (Deepgram STT + OpenRouter LLM + Deepgram TTS).
 *
 * Responsibilities:
 * - Authenticate with Supabase and pass JWT to the selected backend
 * - Classic: capture/play PCM16 audio via AudioWorklets over WebSocket
 * - Pipeline: establish WebRTC peer connection with the Pipecat server
 * - Manage connection lifecycle for both modes
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

/** Refs held during an active classic (WebSocket) call session. */
interface ClassicCallSession {
  ws: WebSocket;
  audioContext: AudioContext;
  micStream: MediaStream;
}

/** Refs held during an active pipeline (WebRTC) call session. */
interface PipelineCallSession {
  peerConnection: RTCPeerConnection;
  micStream: MediaStream;
}

/** Response from POST /start on the Pipecat server. */
interface StartResponse {
  sessionId: string;
  iceServers?: RTCIceServer[];
}

/** Response from POST /sessions/{sessionId}/api/offer on the Pipecat server. */
interface OfferResponse {
  sdp: string;
  type: RTCSdpType;
}

// ============================================================================
// EVENT HANDLERS -- CLASSIC (WEBSOCKET)
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
// EVENT HANDLERS -- PIPELINE (WEBRTC)
// ============================================================================

/**
 * Starts a WebRTC session with the Pipecat voice-pipeline server.
 *
 * Steps:
 * 1. POST /start to get sessionId and ICE servers
 * 2. Create RTCPeerConnection with the returned ICE config
 * 3. Add mic track and set up remote audio playback
 * 4. Create and send SDP offer with the JWT in requestData
 * 5. Apply the SDP answer from the server
 *
 * @param token - Supabase JWT for authentication
 * @param micStream - The microphone MediaStream
 * @returns The pipeline call session with peer connection and mic stream
 */
async function startWebRTCSession(
  token: string,
  micStream: MediaStream
): Promise<PipelineCallSession> {
  // Step 1: POST /start to get session ID and ICE config
  const startRes = await fetch(`${VOICE_PIPELINE_URL}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!startRes.ok) {
    throw new Error(`Failed to start pipeline session: ${startRes.status} ${startRes.statusText}`);
  }

  const startData: StartResponse = await startRes.json();
  const { sessionId, iceServers } = startData;

  // Step 2: Create RTCPeerConnection with ICE config from server
  const peerConnection = new RTCPeerConnection({
    iceServers: iceServers ?? [],
  });

  // Step 3: Add mic audio track to the peer connection
  const micTrack = micStream.getAudioTracks()[0];
  if (!micTrack) {
    throw new Error("No audio track found on microphone stream");
  }
  peerConnection.addTrack(micTrack, micStream);

  // Set up remote audio playback: when the server sends audio, play it
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;

  peerConnection.ontrack = (event: RTCTrackEvent) => {
    remoteStream.addTrack(event.track);
  };

  // Step 4: Create SDP offer and send to server
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const offerRes = await fetch(
    `${VOICE_PIPELINE_URL}/sessions/${sessionId}/api/offer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: offer.sdp,
        type: offer.type,
        requestData: { token },
      }),
    }
  );

  if (!offerRes.ok) {
    peerConnection.close();
    throw new Error(`Failed to send SDP offer: ${offerRes.status} ${offerRes.statusText}`);
  }

  // Step 5: Set the remote SDP answer
  const answerData: OfferResponse = await offerRes.json();
  await peerConnection.setRemoteDescription(
    new RTCSessionDescription({ sdp: answerData.sdp, type: answerData.type })
  );

  return { peerConnection, micStream };
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<CallBackend>("classic");

  // Classic mode refs
  const classicSessionRef = useRef<ClassicCallSession | null>(null);
  const cleanupAudioRef = useRef<(() => void) | null>(null);

  // Pipeline mode refs
  const pipelineSessionRef = useRef<PipelineCallSession | null>(null);

  // Speed control
  const [speed, setSpeed] = useState(1.5);

  // --------------------------------------------------------------------------
  // Speed control
  // --------------------------------------------------------------------------

  /** Updates the TTS playback speed on the pipeline server. */
  const updateSpeed = useCallback(async (newSpeed: number) => {
    setSpeed(newSpeed);
    try {
      await fetch(`${VOICE_PIPELINE_URL}/api/speed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: newSpeed }),
      });
    } catch {
      // Non-critical -- slider still reflects local state
    }
  }, []);

  // --------------------------------------------------------------------------
  // Pipeline call handlers
  // --------------------------------------------------------------------------

  /**
   * Starts a pipeline call via WebRTC to the Pipecat server.
   * Gets JWT, mic stream, and establishes the WebRTC connection.
   */
  const startPipelineCall = useCallback(async () => {
    setError(null);
    setStatus("Connecting to pipeline...");

    try {
      // Get JWT from Supabase
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw new Error("Not authenticated. Please sign in first.");
      }
      const token = sessionData.session.access_token;

      // Request microphone access
      setStatus("Requesting microphone...");
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Establish WebRTC connection
      setStatus("Establishing WebRTC connection...");
      const pipelineSession = await startWebRTCSession(token, micStream);
      pipelineSessionRef.current = pipelineSession;

      // Monitor connection state
      pipelineSession.peerConnection.onconnectionstatechange = () => {
        const state = pipelineSession.peerConnection.connectionState;
        if (state === "connected") {
          setStatus("Pipeline call active");
        } else if (state === "disconnected" || state === "failed" || state === "closed") {
          endPipelineCall();
        }
      };

      setCallActive(true);
      setStatus("Pipeline call active");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start pipeline call";
      setError(msg);
      setStatus("Ready");
      // Clean up mic if it was acquired before the error
      if (pipelineSessionRef.current) {
        cleanupPipelineSession();
      }
    }
  }, []);

  /** Stops the pipeline call by closing the peer connection and mic. */
  const endPipelineCall = useCallback(() => {
    cleanupPipelineSession();
    setCallActive(false);
    setStatus("Ready");
  }, []);

  /** Tears down WebRTC peer connection and mic stream for pipeline mode. */
  function cleanupPipelineSession(): void {
    const session = pipelineSessionRef.current;
    if (!session) return;

    session.peerConnection.onconnectionstatechange = null;
    session.peerConnection.ontrack = null;
    session.peerConnection.close();
    session.micStream.getTracks().forEach((track) => track.stop());
    pipelineSessionRef.current = null;
  }

  // --------------------------------------------------------------------------
  // Classic call handlers
  // --------------------------------------------------------------------------

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
        cleanupClassicSession();
      };

      classicSessionRef.current = { ws, audioContext, micStream };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start call";
      setError(msg);
      setStatus("Ready");
    }
  }, []);

  const endCall = useCallback(() => {
    cleanupClassicSession();
    setCallActive(false);
    setStatus("Ready");
  }, []);

  /** Tears down WebSocket, audio context, and mic stream for classic mode. */
  function cleanupClassicSession(): void {
    if (cleanupAudioRef.current) {
      cleanupAudioRef.current();
      cleanupAudioRef.current = null;
    }

    const session = classicSessionRef.current;
    if (!session) return;

    if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
      session.ws.close();
    }

    session.audioContext.close();
    session.micStream.getTracks().forEach((track) => track.stop());
    classicSessionRef.current = null;
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

        {/* Speed slider -- only visible in pipeline mode */}
        {backend === "pipeline" && (
          <div className="mb-4 flex items-center gap-3">
            <span className="text-sm font-medium text-gray-700">Speed</span>
            <input
              type="range"
              min="1.0"
              max="2.0"
              step="0.1"
              value={speed}
              onChange={(e) => updateSpeed(parseFloat(e.target.value))}
              className="w-44"
            />
            <span className="text-sm font-semibold text-gray-900 w-10">
              {speed.toFixed(1)}x
            </span>
          </div>
        )}

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
