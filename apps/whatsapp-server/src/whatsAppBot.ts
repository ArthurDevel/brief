import { WhatsApp } from "meta-cloud-api";
import { MediaStreamTrackFactory, RTCPeerConnection, type MediaStreamTrack, type RTCIceServer } from "werift";
import {
  DeepgramVoiceMessageTranscriber,
  type VoiceMessageTranscriber,
  type VoiceMessageTranscriptionResult,
} from "./deepgramVoiceMessageTranscriber.js";
import { WhatsAppLiveKitBridge } from "./livekitBridge.js";
import { LiveKitRoomManager } from "./roomManager.js";
import {
  getWhatsAppAuthMessageConfig,
  isAuthenticateGmailCommand,
  isAuthenticateGoogleCalendarCommand,
  isAuthenticateNotionCommand,
  isAuthenticateOutlookCommand,
  isAuthenticateOverviewCommand,
  isVoiceSettingsCommand,
  normalizeWhatsAppCallerPhone,
  sendWhatsAppGmailConnectMessage,
  sendWhatsAppGoogleCalendarConnectMessage,
  sendWhatsAppNotionConnectMessage,
  sendWhatsAppOutlookConnectMessage,
  sendWhatsAppOverviewMessage,
  sendWhatsAppVoiceSettingsMessage,
} from "./whatsappAuthCommands.js";

interface WhatsAppCallSession {
  sdp_type?: "offer" | "answer";
  sdp?: string;
}

interface WhatsAppCall {
  id?: string;
  event?: string;
  from?: string;
  session?: WhatsAppCallSession;
}

interface WhatsAppMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: {
    body?: string;
  };
  audio?: {
    id?: string;
    mime_type?: string;
    url?: string;
    voice?: boolean;
  };
}

interface WhatsAppCallChangeValue {
  messages?: WhatsAppMessage[];
  calls?: WhatsAppCall[];
}

interface WhatsAppCallChange {
  field?: string;
  value?: WhatsAppCallChangeValue;
}

interface WhatsAppCallEntry {
  changes?: WhatsAppCallChange[];
}

export interface WhatsAppWebhookBody {
  entry?: WhatsAppCallEntry[];
  calls?: WhatsAppCall[];
}

interface ActiveCallSession {
  readonly callId: string;
  readonly peerConnection: RTCPeerConnection;
  readonly disposeAudioTrack: () => void;
  readonly roomName: string;
  bridge: WhatsAppLiveKitBridge | null;
  cleanedUp: boolean;
}

interface InboundTextMessage {
  body: string;
  from: string;
  replyMessageId?: string;
}

interface WhatsAppClient {
  messages: {
    text(params: {
      body: string;
      to: string;
      replyMessageId?: string;
    }): Promise<unknown>;
  };
  media: {
    getMediaById(mediaId: string): Promise<{
      url: string;
      mime_type: string;
    }>;
  };
  calling: {
    preAcceptCall(params: {
      call_id: string;
      session: {
        sdp_type: "answer";
        sdp: string;
      };
    }): Promise<unknown>;
    acceptCall(params: {
      call_id: string;
      session: {
        sdp_type: "answer";
        sdp: string;
      };
      biz_opaque_callback_data: string;
    }): Promise<unknown>;
    rejectCall(params: { call_id: string }): Promise<unknown>;
  };
}

interface CallSessionManager {
  createCallSession(callId: string, caller: string | undefined): Promise<{
    roomName: string;
    participantIdentity: string;
    token: string;
    url: string;
  }>;
  cleanupCallSession(roomName: string): Promise<void>;
}

interface WhatsAppBotDependencies {
  client?: WhatsAppClient;
  roomManager?: CallSessionManager;
  voiceMessageTranscriber?: VoiceMessageTranscriber;
  fetchImplementation?: typeof fetch;
}

interface VoiceBotEnv {
  accessToken: string;
  phoneNumberId: number;
  businessAcctId: string;
  apiVersion: string;
  iceServers: RTCIceServer[];
}

const DEFAULT_API_VERSION = "23";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let cachedEnv: VoiceBotEnv | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required for WhatsApp calling`);
  }
  return value;
}

function getIceServers(): RTCIceServer[] {
  const raw = process.env.WHATSAPP_CALL_ICE_SERVERS_JSON?.trim();
  if (!raw) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("must be a non-empty JSON array");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `WHATSAPP_CALL_ICE_SERVERS_JSON must be valid JSON RTCIceServer[]: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function normalizeApiVersion(rawVersion: string): string {
  const normalized = rawVersion.trim().replace(/^v/i, "").replace(/\.0$/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `WHATSAPP_API_VERSION must look like 23, 23.0, or v23.0; received "${rawVersion}"`
    );
  }
  return normalized;
}

function getVoiceBotEnv(): VoiceBotEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const phoneNumberId = Number.parseInt(requireEnv("WHATSAPP_PHONE_NUMBER_ID"), 10);
  if (!Number.isFinite(phoneNumberId)) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID must be a valid integer");
  }

  const rawApiVersion = process.env.WHATSAPP_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const apiVersion = normalizeApiVersion(rawApiVersion);
  if (apiVersion !== rawApiVersion) {
    console.warn(
      `[whatsapp-server] normalized WHATSAPP_API_VERSION from "${rawApiVersion}" to "${apiVersion}" for meta-cloud-api`
    );
  }

  cachedEnv = {
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId,
    businessAcctId: requireEnv("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    apiVersion,
    iceServers: getIceServers()
  };

  return cachedEnv;
}

function createClient(): WhatsApp {
  const env = getVoiceBotEnv();
  return new WhatsApp({
    accessToken: env.accessToken,
    phoneNumberId: env.phoneNumberId,
    businessAcctId: env.businessAcctId,
    apiVersion: env.apiVersion
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForIceGathering(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (peerConnection.iceGatheringState !== "complete" && Date.now() - startedAt < timeoutMs) {
    await delay(100);
  }
}

async function waitForConnection(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (peerConnection.connectionState === "connected") {
      return;
    }
    if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
      throw new Error(`peer connection entered ${peerConnection.connectionState}`);
    }
    await delay(100);
  }
}

function isCallConnect(call: WhatsAppCall): boolean {
  return call.event === "connect" && call.session?.sdp_type === "offer" && typeof call.session.sdp === "string";
}

function isCallTerminate(call: WhatsAppCall): boolean {
  return call.event === "terminate";
}

export class WhatsAppBot {
  private readonly client: WhatsAppClient;
  private readonly activeCalls = new Map<string, ActiveCallSession>();
  private readonly connectingCallIds = new Set<string>();
  private readonly roomManager: CallSessionManager;
  private readonly voiceMessageTranscriber: VoiceMessageTranscriber;
  private readonly fetchImplementation: typeof fetch;

  constructor(dependencies: WhatsAppBotDependencies = {}) {
    this.client = dependencies.client ?? createClient();
    this.roomManager = dependencies.roomManager ?? new LiveKitRoomManager();
    this.voiceMessageTranscriber =
      dependencies.voiceMessageTranscriber ?? new DeepgramVoiceMessageTranscriber();
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
  }

  async handleWebhook(body: WhatsAppWebhookBody): Promise<void> {
    const pendingCallTasks: Promise<void>[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === "messages") {
          for (const message of change.value?.messages ?? []) {
            await this.handleIncomingMessage(message);
          }
          continue;
        }

        if (change.field === "calls") {
          for (const call of change.value?.calls ?? []) {
            const callId = call.id;
            if (!callId) {
              continue;
            }

            if (isCallConnect(call)) {
              if (this.activeCalls.has(callId) || this.connectingCallIds.has(callId)) {
                continue;
              }

              this.connectingCallIds.add(callId);
              const callTask = this.handleConnect(callId, call).finally(() => {
                this.connectingCallIds.delete(callId);
              });
              pendingCallTasks.push(callTask);
              continue;
            }

            if (isCallTerminate(call)) {
              await this.cleanupCall(callId);
            }
          }
        }
      }
    }

    await Promise.all(pendingCallTasks);
  }

  private async handleIncomingMessage(message: WhatsAppMessage): Promise<void> {
    if (message.type === "text") {
      await this.handleIncomingTextMessage(message);
      return;
    }

    if (message.type === "audio") {
      await this.handleIncomingAudioMessage(message);
    }
  }

  private async handleIncomingTextMessage(message: WhatsAppMessage): Promise<void> {
    const from = message.from?.trim();
    if (!from) {
      return;
    }

    await this.sendTypingIndicator(message).catch((error) => {
      console.warn("[whatsapp-server] failed to send typing indicator", {
        messageId: message.id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    const body = message.text?.body?.trim() ?? "";
    await this.processInboundTextMessage({
      body,
      from,
      replyMessageId: message.id
    });
  }

  private async handleIncomingAudioMessage(message: WhatsAppMessage): Promise<void> {
    const from = message.from?.trim();
    if (!from) {
      return;
    }

    await this.sendTypingIndicator(message).catch((error) => {
      console.warn("[whatsapp-server] failed to send typing indicator", {
        messageId: message.id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    try {
      const transcription = await this.transcribeAudioMessage(message);
      console.info("[whatsapp-server] transcribed voice message", {
        from,
        messageId: message.id ?? null,
        isVoiceNote: message.audio?.voice ?? false,
        confidence: transcription.confidence,
        transcript: transcription.transcript
      });

      const handled = await this.processInboundTextMessage({
        body: transcription.transcript,
        from,
        replyMessageId: message.id
      });

      if (handled) {
        return;
      }

      await this.replyWithTranscript(from, message.id, transcription.transcript);
    } catch (error) {
      console.error("[whatsapp-server] failed to process voice message", {
        from,
        messageId: message.id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });

      await this.client.messages.text({
        body: "I couldn't transcribe your voice message. Please try again.",
        to: from,
        replyMessageId: message.id
      });
    }
  }

  private async processInboundTextMessage(message: InboundTextMessage): Promise<boolean> {
    const body = message.body.trim();
    if (!body) {
      return false;
    }

    const normalizedPhone = normalizeWhatsAppCallerPhone(message.from);
    if (
      isAuthenticateGmailCommand(body) ||
      isAuthenticateGoogleCalendarCommand(body) ||
      isAuthenticateNotionCommand(body) ||
      isAuthenticateOutlookCommand(body) ||
      isAuthenticateOverviewCommand(body) ||
      isVoiceSettingsCommand(body)
    ) {
      if (!normalizedPhone) {
        console.warn("[whatsapp-server] could not normalize sender phone for auth command", {
          rawPhone: message.from,
          messageId: message.replyMessageId ?? null,
        });
        return true;
      }

      console.info("[whatsapp-server] sending auth command message", {
        phone: normalizedPhone,
        command: body.toLowerCase(),
        messageId: message.replyMessageId ?? null,
      });

      const messageConfig = getWhatsAppAuthMessageConfig();

      if (isAuthenticateGmailCommand(body)) {
        await sendWhatsAppGmailConnectMessage(messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateGoogleCalendarCommand(body)) {
        await sendWhatsAppGoogleCalendarConnectMessage(messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateNotionCommand(body)) {
        await sendWhatsAppNotionConnectMessage(messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateOutlookCommand(body)) {
        await sendWhatsAppOutlookConnectMessage(messageConfig, normalizedPhone);
        return true;
      }

      if (isVoiceSettingsCommand(body)) {
        await sendWhatsAppVoiceSettingsMessage(messageConfig, normalizedPhone);
        return true;
      }

      await sendWhatsAppOverviewMessage(messageConfig, normalizedPhone);
      return true;
    }

    if (body.toLowerCase() !== "hello world") {
      return false;
    }

    console.log(`[whatsapp-server] replying to text message from ${message.from}`);
    await this.client.messages.text({
      body: "received",
      to: message.from,
      replyMessageId: message.replyMessageId
    });
    return true;
  }

  private async transcribeAudioMessage(
    message: WhatsAppMessage
  ): Promise<VoiceMessageTranscriptionResult> {
    const audioId = message.audio?.id?.trim();
    if (!audioId) {
      throw new Error("Incoming audio message is missing audio.id");
    }

    const media = message.audio?.url
      ? null
      : await this.client.media.getMediaById(audioId);
    const mediaUrl = message.audio?.url?.trim() || media?.url?.trim();
    if (!mediaUrl) {
      throw new Error(`WhatsApp media ${audioId} is missing a download URL`);
    }

    const mimeType = message.audio?.mime_type?.trim() || media?.mime_type?.trim();
    if (!mimeType) {
      throw new Error(`WhatsApp media ${audioId} is missing a MIME type`);
    }

    const audioBuffer = await this.downloadWhatsAppMediaBuffer(mediaUrl);
    return await this.voiceMessageTranscriber.transcribeVoiceMessage({
      audioBuffer,
      mimeType
    });
  }

  private async downloadWhatsAppMediaBuffer(mediaUrl: string): Promise<Buffer> {
    const response = await this.fetchImplementation(mediaUrl, {
      headers: {
        Authorization: `Bearer ${getVoiceBotEnv().accessToken}`
      }
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`WhatsApp media download failed: ${payload}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async sendTypingIndicator(message: WhatsAppMessage): Promise<void> {
    const messageId = message.id?.trim();
    if (!messageId) {
      return;
    }

    const env = getVoiceBotEnv();
    const response = await this.fetchImplementation(
      `https://graph.facebook.com/v${env.apiVersion}.0/${env.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: {
            type: "text"
          }
        })
      }
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`WhatsApp typing indicator failed: ${payload}`);
    }
  }

  private async replyWithTranscript(
    to: string,
    replyMessageId: string | undefined,
    transcript: string
  ): Promise<void> {
    await this.client.messages.text({
      body: `I transcribed your voice message as:\n\n${transcript}`,
      to,
      replyMessageId
    });
  }

  private async handleConnect(callId: string, call: WhatsAppCall): Promise<void> {
    const offerSdp = call.session?.sdp;
    if (!offerSdp) {
      return;
    }

    const normalizedCaller = normalizeWhatsAppCallerPhone(call.from?.trim());

    console.log(`[whatsapp-server] answering call ${callId} from ${normalizedCaller ?? call.from ?? "unknown"}`);

    const [audioTrack, audioPort, disposeAudioTrack] = await MediaStreamTrackFactory.rtpSource({
      kind: "audio"
    });
    const peerConnection = new RTCPeerConnection({
      iceServers: getVoiceBotEnv().iceServers
    });
    const incomingTrackPromise = this.waitForIncomingAudioTrack(peerConnection);
    const liveKitSession = await this.roomManager.createCallSession(callId, normalizedCaller ?? undefined);

    const activeCall: ActiveCallSession = {
      callId,
      peerConnection,
      disposeAudioTrack,
      roomName: liveKitSession.roomName,
      bridge: null,
      cleanedUp: false
    };
    this.activeCalls.set(callId, activeCall);

    try {
      peerConnection.addTrack(audioTrack);
      await peerConnection.setRemoteDescription({ type: "offer", sdp: offerSdp });

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription({
        type: "answer",
        sdp: answer.sdp
      });
      await waitForIceGathering(peerConnection, 3000);

      const localSdp = peerConnection.localDescription?.sdp;
      if (!localSdp) {
        throw new Error("failed to generate local SDP answer");
      }

      const session = {
        sdp_type: "answer" as const,
        sdp: localSdp
      };

      await this.client.calling.preAcceptCall({
        call_id: callId,
        session
      });
      await this.client.calling.acceptCall({
        call_id: callId,
        session,
        biz_opaque_callback_data: "whatsapp-server-greeting"
      });

      try {
        await waitForConnection(peerConnection, 8000);
      } catch (error) {
        console.warn(
          `[whatsapp-server] call ${callId} did not reach connected state before audio bridge: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const incomingTrack = await incomingTrackPromise;
      const bridge = new WhatsAppLiveKitBridge({
        callId,
        roomName: liveKitSession.roomName,
        token: liveKitSession.token,
        url: liveKitSession.url,
        participantIdentity: liveKitSession.participantIdentity,
        incomingTrack,
        outgoingAudioPort: audioPort,
        remoteSdp: offerSdp
      });

      activeCall.bridge = bridge;
      await bridge.start();
      await bridge.waitUntilClosed();
    } catch (error) {
      console.error(`[whatsapp-server] failed to handle call ${callId}`, error);
      try {
        await this.client.calling.rejectCall({ call_id: callId });
      } catch (rejectError) {
        console.error(`[whatsapp-server] failed to reject call ${callId}`, rejectError);
      }
    } finally {
      await this.cleanupCall(callId);
    }
  }

  private async cleanupCall(callId: string): Promise<void> {
    const activeCall = this.activeCalls.get(callId);
    if (!activeCall || activeCall.cleanedUp) {
      return;
    }

    activeCall.cleanedUp = true;
    this.activeCalls.delete(callId);

    if (activeCall.bridge) {
      await activeCall.bridge.close().catch(() => undefined);
    }

    activeCall.disposeAudioTrack();
    await activeCall.peerConnection.close().catch(() => undefined);
    await this.roomManager.cleanupCallSession(activeCall.roomName).catch(() => undefined);
    console.log(`[whatsapp-server] cleaned up call ${callId}`);
  }

  private async waitForIncomingAudioTrack(peerConnection: RTCPeerConnection): Promise<MediaStreamTrack> {
    const existingTrack = peerConnection.getReceivers().find((receiver) => receiver.track.kind === "audio")?.track;
    if (existingTrack) {
      return existingTrack;
    }

    return await new Promise<MediaStreamTrack>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timed out waiting for incoming audio track"));
      }, 10_000);

      peerConnection.onTrack.subscribe((track) => {
        if (track.kind !== "audio") {
          return;
        }

        clearTimeout(timeout);
        resolve(track);
      });
    });
  }
}
