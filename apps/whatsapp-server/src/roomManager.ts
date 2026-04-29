import { randomUUID } from "node:crypto";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { toHttpUrl, toWebSocketUrl } from "./livekitUrls.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

interface LiveKitEnv {
  httpUrl: string;
  wsUrl: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
}

export interface LiveKitCallSession {
  roomName: string;
  participantIdentity: string;
  token: string;
  url: string;
}

let cachedEnv: LiveKitEnv | null = null;

function getLiveKitEnv(): LiveKitEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const livekitUrl = requireEnv("LIVEKIT_URL");
  cachedEnv = {
    httpUrl: toHttpUrl(livekitUrl),
    wsUrl: toWebSocketUrl(livekitUrl),
    apiKey: requireEnv("LIVEKIT_API_KEY"),
    apiSecret: requireEnv("LIVEKIT_API_SECRET"),
    agentName: process.env.LIVEKIT_AGENT_NAME?.trim() || "whatsapp-composio-agent"
  };

  return cachedEnv;
}

export class LiveKitRoomManager {
  private readonly env = getLiveKitEnv();
  private readonly roomClient = new RoomServiceClient(
    this.env.httpUrl,
    this.env.apiKey,
    this.env.apiSecret
  );
  private readonly dispatchClient = new AgentDispatchClient(
    this.env.httpUrl,
    this.env.apiKey,
    this.env.apiSecret
  );

  async createCallSession(callId: string, caller: string | undefined): Promise<LiveKitCallSession> {
    const roomName = `wa-call-${callId}`;
    const participantIdentity = `bridge-${callId}-${randomUUID()}`;
    const metadata = JSON.stringify({
      callId,
      caller: caller ?? null,
      transport: "whatsapp"
    });

    // LiveKit CreateDispatch creates the room when it does not exist.
    await this.dispatchClient.createDispatch(roomName, this.env.agentName, { metadata });

    const token = new AccessToken(this.env.apiKey, this.env.apiSecret, {
      identity: participantIdentity,
      name: "WhatsApp Bridge",
      metadata
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false
    });

    return {
      roomName,
      participantIdentity,
      token: await token.toJwt(),
      url: this.env.wsUrl
    };
  }

  async cleanupCallSession(roomName: string): Promise<void> {
    await this.roomClient.deleteRoom(roomName).catch(() => undefined);
  }
}
