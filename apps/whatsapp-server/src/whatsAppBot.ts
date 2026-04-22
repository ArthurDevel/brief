import { MediaStreamTrackFactory, RTCPeerConnection, type MediaStreamTrack, type RTCIceServer } from "werift";
import {
  WhatsAppUserNotFoundError,
} from "@dublin/whatsapp-core";
import {
  DeepgramVoiceMessageTranscriber,
  type VoiceMessageTranscriber,
  type VoiceMessageTranscriptionResult,
} from "./deepgramVoiceMessageTranscriber.js";
import { WhatsAppLiveKitBridge } from "./livekitBridge.js";
import { LiveKitRoomManager } from "./roomManager.js";
import {
  createWhatsAppTransport,
  type LegacyWhatsAppClient,
  type WhatsAppCallSessionParams,
  type WhatsAppTransport,
} from "./whatsappTransport.js";
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
import {
  createWhatsAppInteractionAgent,
  type WhatsAppInteractionAgent,
} from "./text/interactionAgent.js";
import {
  createWhatsAppTextConversationStore,
  type WhatsAppTextConversationStore,
} from "./text/conversationStore.js";
import type { WhatsAppUserVisibleActionDto } from "./text/types.js";

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
  rawPayload?: unknown;
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
  client?: LegacyWhatsAppClient;
  roomManager?: CallSessionManager;
  transport?: WhatsAppTransport;
  voiceMessageTranscriber?: VoiceMessageTranscriber;
  fetchImplementation?: typeof fetch;
  textConversationStore?: WhatsAppTextConversationStore;
  textInteractionAgent?: WhatsAppInteractionAgent;
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
  private readonly activeCalls = new Map<string, ActiveCallSession>();
  private readonly connectingCallIds = new Set<string>();
  private readonly roomManager: CallSessionManager;
  private readonly transport: WhatsAppTransport;
  private readonly textConversationStore: WhatsAppTextConversationStore;
  private readonly textInteractionAgent: WhatsAppInteractionAgent;
  private readonly voiceMessageTranscriber: VoiceMessageTranscriber;
  private readonly fetchImplementation: typeof fetch;

  constructor(dependencies: WhatsAppBotDependencies = {}) {
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.transport =
      dependencies.transport
      ?? createWhatsAppTransport({
        client: dependencies.client,
        fetchImplementation: this.fetchImplementation
      });
    this.roomManager = dependencies.roomManager ?? new LiveKitRoomManager();
    this.textConversationStore =
      dependencies.textConversationStore ?? createWhatsAppTextConversationStore();
    this.textInteractionAgent =
      dependencies.textInteractionAgent ?? createWhatsAppInteractionAgent();
    this.voiceMessageTranscriber =
      dependencies.voiceMessageTranscriber ?? new DeepgramVoiceMessageTranscriber();
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
      console.warn("[whatsapp-server] skipping text message without sender", {
        messageId: message.id ?? null,
      });
      return;
    }

    console.info("[whatsapp-server] start text message handling", {
      from,
      messageId: message.id ?? null,
      textLength: message.text?.body?.trim().length ?? 0,
    });

    await this.sendTypingIndicator(message).catch((error) => {
      console.warn("[whatsapp-server] failed to send typing indicator", {
        messageId: message.id ?? null,
        from,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    const body = message.text?.body?.trim() ?? "";
    console.info("[whatsapp-server] start inbound text processing", {
      from,
      messageId: message.id ?? null,
      textLength: body.length,
    });
    await this.processInboundTextMessage({
      body,
      from,
      replyMessageId: message.id,
      rawPayload: message,
    });
    console.info("[whatsapp-server] finished text message handling", {
      from,
      messageId: message.id ?? null,
      textLength: body.length,
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
        replyMessageId: message.id,
        rawPayload: {
          originalMessage: message,
          transcription,
        },
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

      await this.transport.sendTextMessage({
        body: "I couldn't transcribe your voice message. Please try again.",
        to: from,
        replyMessageId: message.id
      });
    }
  }

  private async processInboundTextMessage(message: InboundTextMessage): Promise<boolean> {
    const body = message.body.trim();
    if (!body) {
      console.info("[whatsapp-server] skipping empty inbound text message", {
        from: message.from,
        messageId: message.replyMessageId ?? null,
      });
      return false;
    }

    console.info("[whatsapp-server] classify inbound text message", {
      from: message.from,
      messageId: message.replyMessageId ?? null,
      textLength: body.length,
    });

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
        await sendWhatsAppGmailConnectMessage(this.transport, messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateGoogleCalendarCommand(body)) {
        await sendWhatsAppGoogleCalendarConnectMessage(this.transport, messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateNotionCommand(body)) {
        await sendWhatsAppNotionConnectMessage(this.transport, messageConfig, normalizedPhone);
        return true;
      }

      if (isAuthenticateOutlookCommand(body)) {
        await sendWhatsAppOutlookConnectMessage(this.transport, messageConfig, normalizedPhone);
        return true;
      }

      if (isVoiceSettingsCommand(body)) {
        await sendWhatsAppVoiceSettingsMessage(this.transport, messageConfig, normalizedPhone);
        return true;
      }

      await sendWhatsAppOverviewMessage(this.transport, messageConfig, normalizedPhone);
      return true;
    }

    console.info("[whatsapp-server] route inbound text message to interaction agent", {
      from: message.from,
      messageId: message.replyMessageId ?? null,
      textLength: body.length,
    });
    await this.handleInteractionAgentTextMessage(message);
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
      : await this.transport.getMediaById(audioId);
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
      console.info("[whatsapp-server] skipping typing indicator because message id is missing", {
        from: message.from?.trim() ?? null,
      });
      return;
    }

    console.info("[whatsapp-server] sending typing indicator", {
      from: message.from?.trim() ?? null,
      messageId,
    });
    await this.transport.sendTypingIndicator({
      messageId,
      to: message.from?.trim() ?? ""
    });
    console.info("[whatsapp-server] sent typing indicator", {
      from: message.from?.trim() ?? null,
      messageId,
    });
  }

  private async replyWithTranscript(
    to: string,
    replyMessageId: string | undefined,
    transcript: string
  ): Promise<void> {
    await this.transport.sendTextMessage({
      body: `I transcribed your voice message as:\n\n${transcript}`,
      to,
      replyMessageId
    });
  }

  private async handleInteractionAgentTextMessage(message: InboundTextMessage): Promise<void> {
    try {
      const messageId = message.replyMessageId?.trim();
      if (!messageId) {
        throw new Error("Incoming WhatsApp text message is missing message.id");
      }

      console.info("[whatsapp-server] handling interaction-agent text message", {
        from: message.from,
        messageId,
        textLength: message.body.length,
      });

      console.info("[whatsapp-server] preparing inbound text turn", {
        from: message.from,
        messageId,
        textLength: message.body.length,
      });
      const preparedTurn = await this.textConversationStore.prepareInboundTurn({
        fromPhone: message.from,
        messageId,
        rawPayload: message.rawPayload ?? {},
        text: message.body,
      });
      console.info("[whatsapp-server] prepared inbound text turn", {
        from: message.from,
        messageId,
        status: preparedTurn.status,
        hasTurn: Boolean(preparedTurn.turn),
      });

      if (preparedTurn.status === "duplicate" || !preparedTurn.turn) {
        console.info("[whatsapp-server] skipping duplicate inbound text message", {
          from: message.from,
          messageId: message.replyMessageId ?? null,
        });
        return;
      }

      console.info("[whatsapp-server] running interaction-agent text turn", {
        from: message.from,
        messageId,
        userId: preparedTurn.linkedUser.userId,
      });

      await this.textInteractionAgent.runTurn(
        preparedTurn.turn,
        async (action) => {
          await this.sendUserVisibleAction(
            action,
            message.from,
            message.replyMessageId,
            preparedTurn.linkedUser
          );
        }
      );

      console.info("[whatsapp-server] finished interaction-agent text turn", {
        from: message.from,
        messageId,
        userId: preparedTurn.linkedUser.userId,
      });
    } catch (error) {
      if (error instanceof WhatsAppUserNotFoundError) {
        await this.replyToUnknownWhatsAppUser(message);
        return;
      }

      console.error("[whatsapp-server] text interaction agent failed", {
        from: message.from,
        messageId: message.replyMessageId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.replyWithTextAgentFailure(message);
    }
  }

  private async replyToUnknownWhatsAppUser(message: InboundTextMessage): Promise<void> {
    await this.transport.sendTextMessage({
      body: "I couldn't find an account for this WhatsApp number. Send authenticate overview to connect first.",
      to: message.from,
      replyMessageId: message.replyMessageId,
    });
  }

  private async replyWithTextAgentFailure(message: InboundTextMessage): Promise<void> {
    await this.transport.sendTextMessage({
      body: "The WhatsApp text assistant is unavailable right now. Please try again later.",
      to: message.from,
      replyMessageId: message.replyMessageId,
    });
  }

  /**
   * Sends one user-visible interaction action and records it in storage.
   * @param action - User-visible interaction action
   * @param to - WhatsApp destination phone
   * @param replyMessageId - Message ID to reply to
   * @param linkedUser - Linked WhatsApp user
   * @returns Promise that resolves when the action is sent and stored
   */
  private async sendUserVisibleAction(
    action: WhatsAppUserVisibleActionDto,
    to: string,
    replyMessageId: string | undefined,
    linkedUser: { userId: string; whatsappPhone: string }
  ): Promise<void> {
    const replyText = this.renderUserVisibleAction(action);
    console.info("[whatsapp-server] sending user-visible action", {
      actionType: action.type,
      replyLength: replyText.length,
      replyMessageId: replyMessageId ?? null,
      to,
      userId: linkedUser.userId,
    });
    await this.transport.sendTextMessage({
      body: replyText,
      to,
      replyMessageId,
    });
    await this.textConversationStore.recordOutboundReply({
      linkedUser,
      rawPayload: {
        action,
        inReplyToMessageId: replyMessageId ?? null,
        text: replyText,
      },
      replyText,
    });
    console.info("[whatsapp-server] sent user-visible action", {
      actionType: action.type,
      replyLength: replyText.length,
      replyMessageId: replyMessageId ?? null,
      to,
      userId: linkedUser.userId,
    });
  }

  /**
   * Renders one user-visible interaction action into WhatsApp text.
   * @param action - User-visible action produced by the interaction agent
   * @returns WhatsApp message body
   */
  private renderUserVisibleAction(action: WhatsAppUserVisibleActionDto): string {
    if (action.type === "message") {
      return action.message;
    }

    return [
      `Draft to: ${action.to}`,
      `Subject: ${action.subject}`,
      "",
      action.body,
    ].join("\n");
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

      const session: WhatsAppCallSessionParams = {
        sdp_type: "answer" as const,
        sdp: localSdp
      };

      await this.transport.preAcceptCall(callId, session);
      await this.transport.acceptCall(callId, session, "whatsapp-server-greeting");

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
        await this.transport.rejectCall(callId);
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
