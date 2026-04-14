"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LoaderCircle, Mic, Phone, PhoneOff, RefreshCcw, Waves } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";
import {
  INITIAL_CALL_UI_STATE,
  transitionCallUiState,
  type CallPhase,
  type CallUiState,
} from "./callUiState";

const VOICE_PIPELINE_URL =
  process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ?? "http://localhost:7860";

const ICE_GATHERING_TIMEOUT_MS = 3000;
const PROGRESS_BEEP_PATTERN_SECS = 6.0;
const PROGRESS_BEEP_ON_SECS = 2.0;
const PROGRESS_BEEP_GAIN = 0.14;
const PROGRESS_BEEP_FADE_SECS = 0.008;
const REMOTE_AUDIO_RMS_THRESHOLD = 0.015;
const REMOTE_AUDIO_CONFIRMATION_FRAMES = 3;

interface PipelineCallSession {
  peerConnection: RTCPeerConnection;
  micStream: MediaStream;
  remoteAudio: HTMLAudioElement;
  remoteStream: MediaStream;
}

interface StartResponse {
  sessionId: string;
  iceServers?: RTCIceServer[];
}

interface OfferResponse {
  sdp: string;
  type: RTCSdpType;
}

class CallProgressBeepController {
  private beepAudio: HTMLAudioElement | null = null;
  private beepUrl: string | null = null;
  private monitorAudioContext: AudioContext | null = null;
  private animationFrameId: number | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteAudioData: Uint8Array<ArrayBuffer> | null = null;
  private remoteAudioFramesAboveThreshold = 0;
  private remoteTrackListener: ((event: MediaStreamTrackEvent) => void) | null = null;
  private attachedRemoteStream: MediaStream | null = null;
  private stopped = true;

  constructor(private readonly onAssistantAudioDetected: () => void) {}

  async start(): Promise<void> {
    if (!this.stopped) return;

    this.stopped = false;
    const beepAudio = new Audio(createProgressBeepUrl());
    beepAudio.loop = true;
    beepAudio.volume = 1;
    beepAudio.preload = "auto";
    beepAudio.setAttribute("playsinline", "true");
    this.beepAudio = beepAudio;
    this.beepUrl = beepAudio.src;

    try {
      await beepAudio.play();
    } catch (error) {
      console.warn("[call] Failed to start progress beep", error);
      this.stop();
      return;
    }
  }

  attachRemoteStream(stream: MediaStream): void {
    this.detachRemoteStream();
    this.attachedRemoteStream = stream;

    if (stream.getAudioTracks().length > 0) {
      this.startRemoteAudioMonitor(stream);
      return;
    }

    this.remoteTrackListener = (event: MediaStreamTrackEvent) => {
      if (event.track.kind !== "audio") return;
      this.startRemoteAudioMonitor(stream);
    };
    stream.addEventListener("addtrack", this.remoteTrackListener as EventListener);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.detachRemoteStream();
    this.remoteSource?.disconnect();
    this.remoteSource = null;
    this.remoteAnalyser?.disconnect();
    this.remoteAnalyser = null;
    this.remoteAudioData = null;
    this.remoteAudioFramesAboveThreshold = 0;

    this.beepAudio?.pause();
    this.beepAudio = null;
    if (this.beepUrl) {
      URL.revokeObjectURL(this.beepUrl);
      this.beepUrl = null;
    }

    const context = this.monitorAudioContext;
    this.monitorAudioContext = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
  }

  private startRemoteAudioMonitor(stream: MediaStream): void {
    if (this.stopped || this.remoteSource || stream.getAudioTracks().length === 0) {
      return;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    if (!this.monitorAudioContext) {
      this.monitorAudioContext = new AudioContextCtor();
    }

    this.remoteSource = this.monitorAudioContext.createMediaStreamSource(stream);
    this.remoteAnalyser = this.monitorAudioContext.createAnalyser();
    this.remoteAnalyser.fftSize = 2048;
    this.remoteAudioData = new Uint8Array(this.remoteAnalyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.remoteSource.connect(this.remoteAnalyser);
    this.monitorRemoteAudio();
  }

  private monitorRemoteAudio = (): void => {
    if (this.stopped || !this.remoteAnalyser || !this.remoteAudioData) return;

    this.remoteAnalyser.getByteTimeDomainData(this.remoteAudioData);

    let sumSquares = 0;
    for (const sample of this.remoteAudioData) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / this.remoteAudioData.length);
    if (rms >= REMOTE_AUDIO_RMS_THRESHOLD) {
      this.remoteAudioFramesAboveThreshold += 1;
      if (this.remoteAudioFramesAboveThreshold >= REMOTE_AUDIO_CONFIRMATION_FRAMES) {
        this.onAssistantAudioDetected();
        return;
      }
    } else {
      this.remoteAudioFramesAboveThreshold = 0;
    }

    this.animationFrameId = window.requestAnimationFrame(this.monitorRemoteAudio);
  };

  private detachRemoteStream(): void {
    if (this.attachedRemoteStream && this.remoteTrackListener) {
      this.attachedRemoteStream.removeEventListener(
        "addtrack",
        this.remoteTrackListener as EventListener
      );
    }
    this.remoteTrackListener = null;
    this.attachedRemoteStream = null;
  }
}

function createProgressBeepUrl(): string {
  const sampleRate = 24000;
  const totalSamples = Math.floor(PROGRESS_BEEP_PATTERN_SECS * sampleRate);
  const samples = new Int16Array(totalSamples);

  addRingbackTone(samples, sampleRate, 0, PROGRESS_BEEP_ON_SECS);

  const wavBytes = encodeWav(samples, sampleRate);
  return URL.createObjectURL(new Blob([wavBytes], { type: "audio/wav" }));
}

function addRingbackTone(
  output: Int16Array,
  sampleRate: number,
  startSample: number,
  durationSecs: number
): void {
  const burstSamples = Math.floor(durationSecs * sampleRate);
  const fadeSamples = Math.floor(PROGRESS_BEEP_FADE_SECS * sampleRate);

  for (let i = 0; i < burstSamples && startSample + i < output.length; i += 1) {
    const t = i / sampleRate;
    const raw =
      (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;

    let envelope = 1;
    if (i < fadeSamples) {
      envelope = i / fadeSamples;
    } else if (i > burstSamples - fadeSamples) {
      envelope = (burstSamples - i) / fadeSamples;
    }

    const value = raw * envelope * PROGRESS_BEEP_GAIN;
    output[startSample + i] = Math.max(
      -32767,
      Math.min(32767, Math.round(value * 32767))
    );
  }
}

function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * bytesPerSample, samples[i] ?? 0, true);
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
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
  remoteAudio.setAttribute("playsinline", "true");
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
      void remoteAudio.play().catch(() => undefined);
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

    return { peerConnection, micStream, remoteAudio, remoteStream };
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

export default function StandaloneCallClient() {
  const [uiState, setUiState] = useState<CallUiState>(INITIAL_CALL_UI_STATE);
  const [error, setError] = useState<string | null>(null);
  const pipelineSessionRef = useRef<PipelineCallSession | null>(null);
  const progressBeepRef = useRef<CallProgressBeepController | null>(null);

  const releaseSession = useCallback(() => {
    progressBeepRef.current?.stop();
    progressBeepRef.current = null;

    const session = pipelineSessionRef.current;
    if (!session) return;

    teardownPipelineSession(session);
    pipelineSessionRef.current = null;
  }, []);

  const startCall = useCallback(async (): Promise<void> => {
    if (
      uiState.callActive ||
      uiState.phase === "requesting-microphone" ||
      uiState.phase === "connecting"
    ) {
      return;
    }

    let micStream: MediaStream | null = null;

    setError(null);
    setUiState((state) => transitionCallUiState(state, { type: "connecting" }));

    progressBeepRef.current?.stop();
    const progressBeep = new CallProgressBeepController(() => {
      progressBeepRef.current?.stop();
      progressBeepRef.current = null;
      setUiState((state) =>
        transitionCallUiState(state, { type: "assistant-audio-started" })
      );
    });
    progressBeepRef.current = progressBeep;
    await progressBeep.start();

    try {
      const supabase = createBrowserClient();
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (authError || !sessionData.session) {
        throw { code: "UNAUTHORIZED", error: "Not authenticated. Please sign in first." };
      }

      setUiState((state) =>
        transitionCallUiState(state, { type: "requesting-microphone" })
      );
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setUiState((state) => transitionCallUiState(state, { type: "connecting" }));
      const pipelineSession = await startWebRTCSession(
        sessionData.session.access_token,
        micStream
      );

      progressBeep.attachRemoteStream(pipelineSession.remoteStream);
      pipelineSessionRef.current = pipelineSession;
      pipelineSession.peerConnection.onconnectionstatechange = () => {
        const state = pipelineSession.peerConnection.connectionState;
        if (state === "connected") {
          setUiState((current) =>
            transitionCallUiState(current, { type: "transport-connected" })
          );
          return;
        }

        if (state === "disconnected" || state === "failed" || state === "closed") {
          releaseSession();
          setUiState((current) => transitionCallUiState(current, { type: "ended" }));
        }
      };
    } catch (err) {
      if (!pipelineSessionRef.current && micStream) {
        micStream.getTracks().forEach((track) => track.stop());
      }

      releaseSession();
      setUiState((state) => transitionCallUiState(state, { type: "error" }));
      setError(logAndMapDashboardError(err, "call", "CALL_START_FAILED"));
    }
  }, [releaseSession, uiState.callActive, uiState.phase]);

  const endCall = useCallback(() => {
    releaseSession();
    setError(null);
    setUiState((state) => transitionCallUiState(state, { type: "ended" }));
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

  const copy = getPhaseCopy(uiState.phase, error);
  const isConnecting =
    uiState.phase === "requesting-microphone" || uiState.phase === "connecting";
  const showStartButton = !uiState.callActive;
  const startLabel = isConnecting
    ? uiState.phase === "requesting-microphone"
      ? "Waiting for mic..."
      : "Connecting..."
    : uiState.phase === "error"
      ? "Try again"
      : uiState.phase === "ended"
        ? "Start another call"
        : "Start call";

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
            {isConnecting ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent-color)]" />
            )}
            {uiState.status}
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
                    disabled={isConnecting}
                    className="inline-flex items-center justify-center gap-2 bg-[var(--btn-primary-bg)] px-5 py-3 text-[13px] font-semibold text-[var(--btn-primary-text)] transition hover:bg-[var(--btn-primary-hover)] disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-[var(--btn-primary-bg)]"
                  >
                    {isConnecting ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : uiState.phase === "error" || uiState.phase === "ended" ? (
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
