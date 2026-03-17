/**
 * Browser-based voice call page.
 *
 * Uses WebRTC to connect to the Pipecat voice-pipeline server
 * (Deepgram STT + OpenRouter LLM + Deepgram TTS).
 *
 * Responsibilities:
 * - Authenticate with Supabase and pass JWT to the pipeline
 * - Establish WebRTC peer connection with the Pipecat server
 * - Manage connection lifecycle
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { createBrowserClient } from "@/lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_PIPELINE_URL =
  process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ?? "http://localhost:7860";

// ============================================================================
// TYPES
// ============================================================================

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
// WEBRTC SESSION
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
 */
async function startWebRTCSession(
  token: string,
  micStream: MediaStream
): Promise<PipelineCallSession> {
  const startRes = await fetch(`${VOICE_PIPELINE_URL}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!startRes.ok) {
    throw new Error(`Failed to start pipeline session: ${startRes.status} ${startRes.statusText}`);
  }

  const startData: StartResponse = await startRes.json();
  const { sessionId, iceServers } = startData;

  const peerConnection = new RTCPeerConnection({
    iceServers: iceServers ?? [],
  });

  const micTrack = micStream.getAudioTracks()[0];
  if (!micTrack) {
    throw new Error("No audio track found on microphone stream");
  }
  peerConnection.addTrack(micTrack, micStream);

  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;

  peerConnection.ontrack = (event: RTCTrackEvent) => {
    remoteStream.addTrack(event.track);
  };

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
  const pipelineSessionRef = useRef<PipelineCallSession | null>(null);

  // --------------------------------------------------------------------------
  // Call handlers
  // --------------------------------------------------------------------------

  const startCall = useCallback(async () => {
    setError(null);
    setStatus("Connecting...");

    try {
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw new Error("Not authenticated. Please sign in first.");
      }
      const token = sessionData.session.access_token;

      setStatus("Requesting microphone...");
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus("Establishing WebRTC connection...");
      const pipelineSession = await startWebRTCSession(token, micStream);
      pipelineSessionRef.current = pipelineSession;

      pipelineSession.peerConnection.onconnectionstatechange = () => {
        const state = pipelineSession.peerConnection.connectionState;
        if (state === "connected") {
          setStatus("Call active");
        } else if (state === "disconnected" || state === "failed" || state === "closed") {
          endCall();
        }
      };

      setCallActive(true);
      setStatus("Call active");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start call";
      setError(msg);
      setStatus("Ready");
      if (pipelineSessionRef.current) {
        cleanupSession();
      }
    }
  }, []);

  const endCall = useCallback(() => {
    cleanupSession();
    setCallActive(false);
    setStatus("Ready");
  }, []);

  function cleanupSession(): void {
    const session = pipelineSessionRef.current;
    if (!session) return;

    session.peerConnection.onconnectionstatechange = null;
    session.peerConnection.ontrack = null;
    session.peerConnection.close();
    session.micStream.getTracks().forEach((track) => track.stop());
    pipelineSessionRef.current = null;
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Browser Call</h1>

      {error && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <p className="mb-4 text-sm text-gray-500">
          Voice connection via the Pipecat pipeline (Deepgram STT + OpenRouter LLM + Deepgram TTS). Uses WebRTC.
        </p>

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">{status}</span>

          {!callActive ? (
            <button
              onClick={startCall}
              className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Start Call
            </button>
          ) : (
            <button
              onClick={endCall}
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
