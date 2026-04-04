import "dotenv/config";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { postProcessPcm } from "./audio/postprocess.js";
import { getEnv } from "./lib/env.js";
import { callDeepgramTts } from "./lib/deepgram.js";
import { int16PcmToWavBuffer } from "./lib/wav.js";
import {
  AGENT_NAME,
  AVAILABLE_VOICES,
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  NUM_CHANNELS,
  SAMPLE_RATE,
  SessionConfig
} from "./shared/constants.js";

interface GenerateRequest {
  voice?: string;
  speed?: number;
  text?: string;
}

interface LiveKitSessionRequest {
  voice?: string;
  speed?: number;
}

function validateSessionConfig(input: LiveKitSessionRequest): SessionConfig {
  return {
    voice: typeof input.voice === "string" && input.voice ? input.voice : DEFAULT_VOICE,
    speed: typeof input.speed === "number" ? input.speed : DEFAULT_SPEED
  };
}

async function createParticipantToken(
  roomName: string,
  metadata: string
): Promise<string> {
  const env = getEnv();
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: `reviewer-${randomUUID()}`,
    name: "Voice Reviewer",
    metadata
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });

  return token.toJwt();
}

const env = getEnv();
const roomClient = new RoomServiceClient(env.livekitHttpUrl, env.livekitApiKey, env.livekitApiSecret);
const dispatchClient = new AgentDispatchClient(
  env.livekitHttpUrl,
  env.livekitApiKey,
  env.livekitApiSecret
);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/voices", (_req, res) => {
  res.json(AVAILABLE_VOICES);
});

app.post("/generate", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as GenerateRequest;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const voice = typeof body.voice === "string" && body.voice ? body.voice : DEFAULT_VOICE;
    const speed = typeof body.speed === "number" ? body.speed : DEFAULT_SPEED;
    const rawPcm = await callDeepgramTts(text, voice, env.deepgramApiKey, SAMPLE_RATE);
    const processed = postProcessPcm(rawPcm, {
      speed,
      sampleRate: SAMPLE_RATE,
      numChannels: NUM_CHANNELS
    });
    const wav = int16PcmToWavBuffer(processed, SAMPLE_RATE, NUM_CHANNELS);

    res.setHeader("Content-Type", "audio/wav");
    res.send(wav);
  } catch (error) {
    next(error);
  }
});

app.post("/api/livekit/session", async (req, res, next) => {
  try {
    const config = validateSessionConfig(req.body ?? {});
    const metadata = JSON.stringify(config);
    const roomName = `voice-review-${randomUUID()}`;

    await roomClient.createRoom({
      name: roomName,
      emptyTimeout: 60,
      departureTimeout: 30,
      maxParticipants: 4
    });

    await dispatchClient.createDispatch(roomName, AGENT_NAME, { metadata });
    const token = await createParticipantToken(roomName, metadata);

    res.json({
      roomName,
      token,
      url: env.livekitWsUrl
    });
  } catch (error) {
    next(error);
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(currentDir, "../static");

app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
);

app.listen(env.port, () => {
  console.log(`Voice review server listening on http://localhost:${env.port}`);
});
