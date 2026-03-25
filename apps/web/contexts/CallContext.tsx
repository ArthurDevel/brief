/**
 * Context provider that manages WebRTC call state across the dashboard.
 *
 * Holds the WebRTC peer connection and mic stream in a ref so the call
 * survives navigation between dashboard pages. Audio playback uses an
 * in-memory Audio element (not DOM-attached), so it continues regardless
 * of which page is mounted.
 *
 * Responsibilities:
 * - Own the WebRTC session lifecycle (start, maintain, end)
 * - Expose call state (callActive, status, error) to the dashboard
 * - Clean up resources on unmount or call end
 */

"use client";

import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { createBrowserClient } from "@/lib/supabase/client";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_PIPELINE_URL =
  process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ?? "http://localhost:7860";

/** Max time (ms) to wait for ICE gathering before sending the offer with whatever candidates are available. */
const ICE_GATHERING_TIMEOUT_MS = 3000;

// ============================================================================
// TYPES
// ============================================================================

/** Refs held during an active pipeline (WebRTC) call session. */
interface PipelineCallSession {
  peerConnection: RTCPeerConnection;
  micStream: MediaStream;
  remoteAudio: HTMLAudioElement;
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

/** Values exposed by the CallContext to consuming components. */
interface CallContextValue {
  callActive: boolean;
  status: string;
  error: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
}

// ============================================================================
// CONTEXT
// ============================================================================

const CallContext = createContext<CallContextValue | null>(null);

// ============================================================================
// HELPER FUNCTIONS
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
 * @param token - Supabase JWT access token
 * @param micStream - The user's microphone MediaStream
 * @returns The active call session with peerConnection, micStream, and remoteAudio
 */
async function startWebRTCSession(
  token: string,
  micStream: MediaStream
): Promise<PipelineCallSession> {
  const startRes = await fetch(`${VOICE_PIPELINE_URL}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  if (!startRes.ok) {
    const body = await startRes.json().catch(() => null);
    if (body?.code === "LIMIT_REACHED") {
      throw new Error("You've reached your monthly call limit. Please upgrade your plan.");
    }
    throw new Error(body?.error ?? `${startRes.status} ${startRes.statusText}`);
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

  // Remote audio element lives in memory (not in DOM) so playback
  // continues even when the call page component is unmounted
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;

  peerConnection.ontrack = (event: RTCTrackEvent) => {
    remoteStream.addTrack(event.track);
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Wait for ICE gathering to complete so relay candidates are in the SDP.
  // Without this, the offer SDP has no candidates and the server has nothing
  // to connect to -- ICE stays at "checking" forever.
  // A timeout ensures we don't hang if some TURN servers are slow to respond.
  if (peerConnection.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const done = () => {
        peerConnection.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (peerConnection.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
      peerConnection.addEventListener("icegatheringstatechange", check);
    });
  }

  // Use localDescription (has gathered candidates), not the original offer (empty)
  const gatheredOffer = peerConnection.localDescription!;

  const offerRes = await fetch(
    `${VOICE_PIPELINE_URL}/sessions/${sessionId}/api/offer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: gatheredOffer.sdp,
        type: gatheredOffer.type,
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

  return { peerConnection, micStream, remoteAudio };
}

// ============================================================================
// PROVIDER
// ============================================================================

/**
 * Context provider that manages the WebRTC call lifecycle.
 *
 * Wraps the dashboard layout so call state persists across page navigation.
 * Exposes startCall/endCall and read-only state via the CallContext.
 *
 * @param children - React children to wrap
 * @returns The provider JSX element
 */
export function CallProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const pipelineSessionRef = useRef<PipelineCallSession | null>(null);

  /**
   * Cleans up the current WebRTC session by closing the peer connection,
   * stopping mic tracks, and releasing the remote audio element.
   * Reads directly from the ref to avoid stale closure issues.
   */
  function cleanupSession(): void {
    const session = pipelineSessionRef.current;
    if (!session) return;

    session.peerConnection.onconnectionstatechange = null;
    session.peerConnection.ontrack = null;
    session.peerConnection.close();
    session.micStream.getTracks().forEach((track) => track.stop());
    session.remoteAudio.pause();
    session.remoteAudio.srcObject = null;
    pipelineSessionRef.current = null;
  }

  /**
   * Authenticates with Supabase, requests mic access, and establishes
   * a WebRTC session with the voice pipeline server.
   */
  const startCall = useCallback(async (): Promise<void> => {
    setError(null);
    setStatus("Connecting...");

    try {
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw new Error("Not authenticated. Please sign in first.");
      }
      const token = sessionData.session.access_token;

      setStatus("Setting up audio...");
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus("Connecting...");
      const pipelineSession = await startWebRTCSession(token, micStream);
      pipelineSessionRef.current = pipelineSession;

      // Use inline ref-based cleanup instead of calling endCall() to avoid
      // stale closure issues (see plan technical notes)
      pipelineSession.peerConnection.onconnectionstatechange = () => {
        const state = pipelineSession.peerConnection.connectionState;
        if (state === "connected") {
          setStatus("Call active");
        } else if (state === "disconnected" || state === "failed" || state === "closed") {
          cleanupSession();
          setCallActive(false);
          setStatus("Ready");
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

  /**
   * Ends the active call, cleaning up all WebRTC resources and resetting state.
   */
  const endCall = useCallback((): void => {
    cleanupSession();
    setCallActive(false);
    setStatus("Ready");
  }, []);

  // Release resources if the provider unmounts (e.g., tab close, logout)
  useEffect(() => {
    return () => {
      cleanupSession();
    };
  }, []);

  const value: CallContextValue = {
    callActive,
    status,
    error,
    startCall,
    endCall,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to consume the call context.
 * Must be used within a CallProvider.
 *
 * @returns The call context value with state and methods
 */
export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error("useCall must be used within a CallProvider");
  }
  return context;
}
