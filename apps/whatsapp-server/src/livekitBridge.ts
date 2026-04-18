import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource
} from "@livekit/rtc-node";
import type { MediaStreamTrack } from "werift";

const PCM_SAMPLE_RATE = 48_000;
const PCM_CHANNELS = 1;
const PCM_FRAME_DURATION_MS = 20;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FRAME_BYTES =
  (PCM_SAMPLE_RATE / (1000 / PCM_FRAME_DURATION_MS)) * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;

interface AudioPayloadFormat {
  payloadType: number;
  clockRate: number;
  channels: number;
}

interface LiveKitBridgeOptions {
  callId: string;
  roomName: string;
  token: string;
  url: string;
  participantIdentity: string;
  incomingTrack: MediaStreamTrack;
  outgoingAudioPort: number;
  remoteSdp: string;
}

async function getAvailableUdpPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = typeof address === "string" ? 0 : address.port;
      socket.close();
      resolve(port);
    });
  });
}

function parseRemoteAudioFormat(sdp: string): AudioPayloadFormat {
  const audioSection = sdp.match(/m=audio\s+\d+\s+UDP\/TLS\/RTP\/SAVPF\s+([0-9 ]+)/i);
  const payloadTypes = audioSection?.[1]
    ?.split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite);

  const opusPayloadType = payloadTypes?.find((payloadType) => {
    const pattern = new RegExp(`a=rtpmap:${payloadType}\\s+opus\\/(\\d+)(?:\\/(\\d+))?`, "i");
    return pattern.test(sdp);
  });

  if (opusPayloadType) {
    const opusMatch = sdp.match(
      new RegExp(`a=rtpmap:${opusPayloadType}\\s+opus\\/(\\d+)(?:\\/(\\d+))?`, "i")
    );
    return {
      payloadType: opusPayloadType,
      clockRate: Number.parseInt(opusMatch?.[1] ?? "48000", 10),
      channels: Number.parseInt(opusMatch?.[2] ?? "2", 10)
    };
  }

  return {
    payloadType: 111,
    clockRate: 48_000,
    channels: 2
  };
}

function createInboundSdp(port: number, format: AudioPayloadFormat): string {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=WhatsApp inbound audio",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${port} RTP/AVP ${format.payloadType}`,
    `a=rtpmap:${format.payloadType} opus/${format.clockRate}/${format.channels}`,
    "a=recvonly"
  ].join("\n");
}

type FfmpegProcess = ReturnType<typeof spawn>;

function waitForChild(process: FfmpegProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => resolve(code));
  });
}

export class WhatsAppLiveKitBridge {
  private readonly options: LiveKitBridgeOptions;
  private readonly room = new Room();
  private readonly audioSource = new AudioSource(PCM_SAMPLE_RATE, PCM_CHANNELS);
  private readonly localTrack = LocalAudioTrack.createAudioTrack("whatsapp-caller", this.audioSource);
  private readonly inboundSocket = dgram.createSocket("udp4");
  private readonly remoteAudioFormat: AudioPayloadFormat;
  private inboundFfmpeg: FfmpegProcess | null = null;
  private outboundFfmpeg: FfmpegProcess | null = null;
  private tempDir: string | null = null;
  private tempSdpPath: string | null = null;
  private inboundSubscription: { unSubscribe?: () => void } | null = null;
  private outboundPump: Promise<void> | null = null;
  private pcmBuffer = Buffer.alloc(0);
  private closed = false;
  private closePromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(options: LiveKitBridgeOptions) {
    this.options = options;
    this.remoteAudioFormat = parseRemoteAudioFormat(options.remoteSdp);
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await this.room.connect(this.options.url, this.options.token, {
      autoSubscribe: true,
      dynacast: true
    });

    if (!this.room.localParticipant) {
      throw new Error("LiveKit local participant is not available after connect");
    }

    await this.room.localParticipant.publishTrack(this.localTrack, publishOptions);
    await this.startInboundPipeline();
    this.startOutboundPipeline();
    this.subscribeExistingOutboundTracks();
  }

  waitUntilClosed(): Promise<void> {
    return this.closePromise;
  }

  private async startInboundPipeline(): Promise<void> {
    const inboundPort = await getAvailableUdpPort();
    this.tempDir = await mkdtemp(path.join(os.tmpdir(), "wa-livekit-"));
    this.tempSdpPath = path.join(this.tempDir, `${this.options.callId}.sdp`);
    await writeFile(this.tempSdpPath, createInboundSdp(inboundPort, this.remoteAudioFormat), "utf8");

    const inboundFfmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file,udp,rtp",
      "-fflags",
      "nobuffer",
      "-f",
      "sdp",
      "-i",
      this.tempSdpPath,
      "-ac",
      String(PCM_CHANNELS),
      "-ar",
      String(PCM_SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.inboundFfmpeg = inboundFfmpeg;

    inboundFfmpeg.stdout?.on("data", (chunk: Buffer) => {
      void this.handleInboundPcm(chunk);
    });

    inboundFfmpeg.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[whatsapp-server] inbound ffmpeg (${this.options.callId}): ${chunk.toString().trim()}`);
    });

    void waitForChild(inboundFfmpeg).then(() => {
      if (!this.closed) {
        void this.close();
      }
    });

    this.inboundSubscription = this.options.incomingTrack.onReceiveRtp.subscribe((packet) => {
      const payload = packet.serialize();
      this.inboundSocket.send(payload, inboundPort, "127.0.0.1");
    });
  }

  private async handleInboundPcm(chunk: Buffer): Promise<void> {
    this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);

    while (this.pcmBuffer.length >= PCM_FRAME_BYTES) {
      const frameBytes = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
      this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);
      const samples = new Int16Array(
        frameBytes.buffer.slice(
          frameBytes.byteOffset,
          frameBytes.byteOffset + frameBytes.byteLength
        )
      );

      await this.audioSource.captureFrame(
        new AudioFrame(
          samples,
          PCM_SAMPLE_RATE,
          PCM_CHANNELS,
          samples.length / PCM_CHANNELS
        )
      );
    }
  }

  private startOutboundPipeline(): void {
    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.startOutboundTrack(track, publication, participant);
      }
    );
  }

  private subscribeExistingOutboundTracks(): void {
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity === this.options.participantIdentity) {
        continue;
      }

      for (const publication of participant.trackPublications.values()) {
        if (publication.kind !== TrackKind.KIND_AUDIO) {
          continue;
        }

        if (!publication.track && !publication.subscribed) {
          publication.setSubscribed(true);
        }

        if (publication.track) {
          this.startOutboundTrack(
            publication.track as RemoteTrack,
            publication as RemoteTrackPublication,
            participant
          );
        }
      }
    }
  }

  private startOutboundTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    if (this.closed || participant.identity === this.options.participantIdentity || this.outboundPump) {
      return;
    }

    if (publication.kind !== TrackKind.KIND_AUDIO || track.kind !== TrackKind.KIND_AUDIO) {
      return;
    }

    console.log(
      `[whatsapp-server] starting outbound audio for call ${this.options.callId} from participant ${participant.identity}`
    );

    const outboundFfmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(PCM_SAMPLE_RATE),
      "-ac",
      String(PCM_CHANNELS),
      "-i",
      "pipe:0",
      "-ac",
      String(this.remoteAudioFormat.channels),
      "-ar",
      String(this.remoteAudioFormat.clockRate),
      "-c:a",
      "libopus",
      "-application",
      "voip",
      "-frame_duration",
      "20",
      "-payload_type",
      String(this.remoteAudioFormat.payloadType),
      "-f",
      "rtp",
      `rtp://127.0.0.1:${this.options.outgoingAudioPort}`
    ], {
      stdio: ["pipe", "ignore", "pipe"]
    });
    this.outboundFfmpeg = outboundFfmpeg;

    outboundFfmpeg.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[whatsapp-server] outbound ffmpeg (${this.options.callId}): ${chunk.toString().trim()}`);
    });

    this.outboundPump = this.pipeLiveKitAudio(track).finally(() => {
      this.outboundPump = null;
    });
  }

  private async pipeLiveKitAudio(track: unknown): Promise<void> {
    const outboundFfmpeg = this.outboundFfmpeg;
    const stdin = outboundFfmpeg?.stdin;
    if (!stdin) {
      return;
    }

    const stream = new AudioStream(track as never, PCM_SAMPLE_RATE, PCM_CHANNELS);
    for await (const frame of stream) {
      if (this.closed || !stdin.writable) {
        break;
      }

      const data = frame.data as Int16Array;
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const canContinue = stdin.write(buffer);
      if (!canContinue) {
        await new Promise<void>((resolve) => {
          stdin.once("drain", () => resolve());
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return this.closePromise;
    }

    this.closed = true;
    this.inboundSubscription?.unSubscribe?.();
    this.inboundSocket.close();

    if (this.outboundFfmpeg && !this.outboundFfmpeg.killed) {
      this.outboundFfmpeg.stdin?.end();
      this.outboundFfmpeg.kill("SIGTERM");
    }

    if (this.inboundFfmpeg && !this.inboundFfmpeg.killed) {
      this.inboundFfmpeg.kill("SIGTERM");
    }

    await this.localTrack.close().catch(() => undefined);
    await this.room.disconnect().catch(() => undefined);

    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    this.resolveClosed();
    return this.closePromise;
  }
}
