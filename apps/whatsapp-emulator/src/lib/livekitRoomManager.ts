/**
 * LiveKit room management for the WhatsApp emulator.
 *
 * Responsibilities:
 * - Create emulator call rooms that match the WhatsApp agent contract
 * - Dispatch the existing WhatsApp agent into those rooms
 * - Mint browser caller access tokens and clean up rooms on end
 */

import { randomUUID } from "node:crypto";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { EmulatorEnv } from "./env.js";
import type { EmulatorCallSessionDto } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const ROOM_NAME_PREFIX = "wa-call-";
const PARTICIPANT_NAME = "WhatsApp Emulator Caller";
const TRANSPORT_NAME = "whatsapp-emulator";

// ============================================================================
// MAIN HANDLER
// ============================================================================

export class EmulatorLiveKitRoomManager {
  private readonly dispatchClient: AgentDispatchClient;
  private readonly roomClient: RoomServiceClient;
  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly agentName: string;

  /**
   * Creates a LiveKit room manager for the emulator.
   * @param env - Emulator environment config
   */
  constructor(env: EmulatorEnv) {
    const httpUrl = toHttpUrl(env.livekitUrl);

    this.dispatchClient = new AgentDispatchClient(
      httpUrl,
      env.livekitApiKey,
      env.livekitApiSecret
    );
    this.roomClient = new RoomServiceClient(
      httpUrl,
      env.livekitApiKey,
      env.livekitApiSecret
    );
    this.wsUrl = toWebSocketUrl(env.livekitUrl);
    this.apiKey = env.livekitApiKey;
    this.apiSecret = env.livekitApiSecret;
    this.agentName = env.livekitAgentName;
  }

  /**
   * Creates a new emulator call session and dispatches the existing agent.
   * @param callerPhone - Validated caller phone number
   * @returns Browser join details for the emulator UI
   */
  async startCall(callerPhone: string): Promise<EmulatorCallSessionDto> {
    const callId = randomUUID();
    const roomName = `${ROOM_NAME_PREFIX}${callId}`;
    const participantIdentity = `emulator-${callId}-${randomUUID()}`;
    const metadata = JSON.stringify({
      callId,
      caller: callerPhone,
      transport: TRANSPORT_NAME
    });

    try {
      await this.roomClient.createRoom({
        departureTimeout: 15,
        emptyTimeout: 30,
        maxParticipants: 3,
        name: roomName
      });

      await this.dispatchClient.createDispatch(roomName, this.agentName, { metadata });
    } catch (error) {
      await this.roomClient.deleteRoom(roomName).catch(() => undefined);
      throw error;
    }

    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: participantIdentity,
      metadata,
      name: PARTICIPANT_NAME
    });

    token.addGrant({
      canPublish: true,
      canPublishData: false,
      canSubscribe: true,
      room: roomName,
      roomJoin: true
    });

    return {
      callId,
      participantIdentity,
      roomName,
      token: await token.toJwt(),
      url: this.wsUrl
    };
  }

  /**
   * Deletes an emulator room immediately.
   * @param roomName - LiveKit room name to delete
   * @returns Promise that resolves when cleanup finishes
   */
  async endCall(roomName: string): Promise<void> {
    const normalizedRoomName = roomName.trim();
    if (!normalizedRoomName) {
      throw new Error("Room name is required.");
    }

    await this.roomClient.deleteRoom(normalizedRoomName).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.toLowerCase().includes("not found")) {
        throw error;
      }
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts a LiveKit URL into its HTTPS API base URL.
 * @param livekitUrl - LiveKit websocket or HTTP URL
 * @returns Normalized HTTP URL
 */
function toHttpUrl(livekitUrl: string): string {
  const url = new URL(livekitUrl);

  if (url.protocol === "wss:") {
    url.protocol = "https:";
    return url.toString();
  }

  if (url.protocol === "ws:") {
    url.protocol = "http:";
    return url.toString();
  }

  if (url.protocol === "https:" || url.protocol === "http:") {
    return url.toString();
  }

  throw new Error(`Unsupported LIVEKIT_URL protocol: ${url.protocol}`);
}

/**
 * Converts a LiveKit URL into its websocket room URL.
 * @param livekitUrl - LiveKit websocket or HTTP URL
 * @returns Normalized websocket URL
 */
function toWebSocketUrl(livekitUrl: string): string {
  const url = new URL(livekitUrl);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
    return url.toString();
  }

  if (url.protocol === "http:") {
    url.protocol = "ws:";
    return url.toString();
  }

  if (url.protocol === "wss:" || url.protocol === "ws:") {
    return url.toString();
  }

  throw new Error(`Unsupported LIVEKIT_URL protocol: ${url.protocol}`);
}
