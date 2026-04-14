"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mic, Phone, PhoneOff, RefreshCcw, Waves } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";

const VOICE_PIPELINE_URL =
  process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ?? "http://localhost:7860";

const ICE_GATHERING_TIMEOUT_MS = 3000;

type CallPhase =
  | "ready"
  | "requesting-microphone"
  | "connecting"
  | "active"
  | "ended"
  | "error";

interface PipelineCallSession {
  peerConnection: RTCPeerConnection;
  micStream: MediaStream;
  remoteAudio: HTMLAudioElement;
}

interface StartResponse {
  sessionId: string;
  iceServers?: RTCIceServer[];
}

interface OfferResponse {
  sdp: string;
  type: RTCSdpType;
}

function teardownPipelineSession(session: PipelineCallSession | null): void {
  if (!session) return;

  session.peerConnection.onconnectionstatechange = null;
  session.peerConnection.ontrack = null;
  session.peerConnection.close();
  session.micStream.getTracks().forEach((track) => track.stop());
  session.remoteAudio.pause();
  session.remoteAudio.srcObject = null;
}

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
    throw await buildDashboardErrorFromResponse(startRes, {
      code: "CALL_START_FAILED",
      error: `${startRes.status} ${startRes.statusText}`,
    });
  }

  const startData: StartResponse = await startRes.json();
  const peerConnection = new RTCPeerConnection({
    iceServers: startData.iceServers ?? [],
  });

  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;

  try {
    const micTrack = micStream.getAudioTracks()[0];
    if (!micTrack) {
      throw new Error("No audio track found on microphone stream");
    }

    peerConnection.addTrack(micTrack, micStream);
    peerConnection.ontrack = (event: RTCTrackEvent) => {
      remoteStream.addTrack(event.track);
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

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

    const gatheredOffer = peerConnection.localDescription!;
    const offerRes = await fetch(
      `${VOICE_PIPELINE_URL}/sessions/${startData.sessionId}/api/offer`,
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
      throw await buildDashboardErrorFromResponse(offerRes, {
        code: "CALL_CONNECT_FAILED",
        error: `Failed to send SDP offer: ${offerRes.status} ${offerRes.statusText}`,
      });
    }

    const answerData: OfferResponse = await offerRes.json();
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription({ sdp: answerData.sdp, type: answerData.type })
    );

    return { peerConnection, micStream, remoteAudio };
  } catch (error) {
    peerConnection.ontrack = null;
    peerConnection.close();
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    throw error;
  }
}

function getPhaseCopy(phase: CallPhase, error: string | null): {
  eyebrow: string;
  title: string;
  description: string;
} {
  switch (phase) {
    case "requesting-microphone":
      return {
        eyebrow: "Getting ready",
        title: "Allow microphone access",
        description: "Your browser needs permission to use your microphone before the call can start.",
      };
    case "connecting":
      return {
        eyebrow: "Connecting",
        title: "Starting your call",
        description: "This usually takes a moment.",
      };
    case "active":
      return {
        eyebrow: "On the call",
        title: "Your call is live",
        description: "Keep this page open while you talk with your assistant.",
      };
    case "ended":
      return {
        eyebrow: "Ended",
        title: "Call ended",
        description: "You can start another call here whenever you're ready.",
      };
    case "error":
      return {
        eyebrow: "Something went wrong",
        title: "We couldn't start your call",
        description: error ?? "Try again when you're ready.",
      };
    case "ready":
    default:
      return {
        eyebrow: "Call",
        title: "Start your call",
        description: "Use this page for your conversation. If you close it, the call will end.",
      };
  }
}

export default function StandaloneCallClient({
  autostart,
}: {
  autostart: boolean;
}) {
  const [callActive, setCallActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("ready");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const pipelineSessionRef = useRef<PipelineCallSession | null>(null);
  const autostartAttemptedRef = useRef(false);

  const releaseSession = useCallback(() => {
    const session = pipelineSessionRef.current;
    if (!session) return;

    teardownPipelineSession(session);
    pipelineSessionRef.current = null;
  }, []);

  const startCall = useCallback(async (): Promise<void> => {
    if (callActive || phase === "requesting-microphone" || phase === "connecting") {
      return;
    }

    let micStream: MediaStream | null = null;

    setError(null);
    setStatus("Connecting...");
    setPhase("connecting");

    try {
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw { code: "UNAUTHORIZED", error: "Not authenticated. Please sign in first." };
      }

      setStatus("Setting up audio...");
      setPhase("requesting-microphone");
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus("Connecting...");
      setPhase("connecting");
      const pipelineSession = await startWebRTCSession(
        sessionData.session.access_token,
        micStream
      );

      pipelineSessionRef.current = pipelineSession;
      pipelineSession.peerConnection.onconnectionstatechange = () => {
        const state = pipelineSession.peerConnection.connectionState;
        if (state === "connected") {
          setCallActive(true);
          setPhase("active");
          setStatus("Call active");
          return;
        }

        if (state === "disconnected" || state === "failed" || state === "closed") {
          releaseSession();
          setCallActive(false);
          setPhase("ended");
          setStatus("Ready");
        }
      };

      setCallActive(true);
      setPhase("active");
      setStatus("Call active");
    } catch (err) {
      if (!pipelineSessionRef.current && micStream) {
        micStream.getTracks().forEach((track) => track.stop());
      }

      releaseSession();
      setCallActive(false);
      setPhase("error");
      setStatus("Ready");
      setError(logAndMapDashboardError(err, "call", "CALL_START_FAILED"));
    }
  }, [callActive, phase, releaseSession]);

  const endCall = useCallback(() => {
    releaseSession();
    setCallActive(false);
    setError(null);
    setPhase("ended");
    setStatus("Ready");
  }, [releaseSession]);

  useEffect(() => {
    return () => {
      releaseSession();
    };
  }, [releaseSession]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      releaseSession();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [releaseSession]);

  useEffect(() => {
    if (!autostart || autostartAttemptedRef.current) return;

    autostartAttemptedRef.current = true;
    void startCall();
  }, [autostart, startCall]);

  const copy = getPhaseCopy(phase, error);
  const showStartButton = !callActive;
  const startLabel = phase === "error" ? "Try again" : phase === "ended" ? "Start another call" : "Start call";

  return (
    <main className="relative min-h-screen overflow-y-auto bg-[var(--bg-main)]">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(circle at top left, rgba(46,160,67,0.12), transparent 32%), radial-gradient(circle at top right, rgba(17,17,17,0.08), transparent 30%)",
        }}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-6 sm:px-10 lg:px-12">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/dashboard/call"
            className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
          <div className="inline-flex items-center gap-2 border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent-color)]" />
            {status}
          </div>
        </div>

        <div className="flex flex-1 items-center py-10">
          <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1.2fr)_360px]">
            <section className="border border-[var(--border-color)] bg-[var(--bg-surface)] p-8 shadow-[0_24px_80px_rgba(17,17,17,0.06)] sm:p-10">
              <div className="mb-10 inline-flex items-center gap-2 border border-[var(--border-color)] bg-[var(--bg-hover)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
                <Waves className="h-3.5 w-3.5" />
                {copy.eyebrow}
              </div>

              <div className="max-w-2xl">
                <h1
                  className="mb-4 text-4xl leading-tight font-semibold text-[var(--text-primary)] sm:text-5xl"
                  style={{ fontFamily: "var(--font-ibm-plex-serif), serif" }}
                >
                  {copy.title}
                </h1>
                <p className="max-w-xl text-[15px] leading-7 text-[var(--text-secondary)]">
                  {copy.description}
                </p>
              </div>

              {error && (
                <div className="mt-8 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="mt-10 flex flex-wrap items-center gap-3">
                {showStartButton ? (
                  <button
                    onClick={() => void startCall()}
                    disabled={phase === "requesting-microphone" || phase === "connecting"}
                    className="inline-flex items-center justify-center gap-2 bg-[var(--btn-primary-bg)] px-5 py-3 text-[13px] font-semibold text-[var(--btn-primary-text)] transition hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {phase === "error" || phase === "ended" ? (
                      <RefreshCcw className="h-4 w-4" />
                    ) : (
                      <Phone className="h-4 w-4" />
                    )}
                    {startLabel}
                  </button>
                ) : (
                  <button
                    onClick={endCall}
                    className="inline-flex items-center justify-center gap-2 bg-red-600 px-5 py-3 text-[13px] font-semibold text-white transition hover:bg-red-700"
                  >
                    <PhoneOff className="h-4 w-4" />
                    End call
                  </button>
                )}

                <Link
                  href="/dashboard/call"
                  className="inline-flex items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-surface)] px-5 py-3 text-[13px] font-semibold text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
                >
                  Return to dashboard
                </Link>
              </div>
            </section>

            <aside className="flex flex-col justify-between border border-[var(--border-color)] bg-[var(--bg-surface)] p-6 sm:p-8">
              <div>
                <div className="mb-6 inline-flex h-12 w-12 items-center justify-center bg-[var(--bg-hover)] text-[var(--text-primary)]">
                  <Mic className="h-5 w-5" />
                </div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                  Before you start
                </h2>
                <div className="mt-4 space-y-4 text-[14px] leading-6 text-[var(--text-secondary)]">
                  <p>You may be asked to allow microphone access the first time you use this.</p>
                  <p>Keep this page open during the call.</p>
                  <p>You can go back to the dashboard whenever you're done.</p>
                </div>
              </div>

              <div className="mt-8 border border-[var(--border-color)] bg-[var(--bg-hover)] p-4 text-[13px] text-[var(--text-secondary)]">
                If the call does not start, try again and make sure your microphone is available.
              </div>
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}
