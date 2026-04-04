import "dotenv/config";

import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  JobContext,
  JobProcess,
  WorkerOptions,
  voice,
  cli,
  defineAgent,
} from "@livekit/agents";
import { STTv2 } from "@livekit/agents-plugin-deepgram";
import { LLM as OpenAILLM } from "@livekit/agents-plugin-openai";
import { VAD } from "@livekit/agents-plugin-silero";
import { getEnv } from "./lib/env.js";
import {
  AGENT_NAME,
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  SAMPLE_RATE,
  SYSTEM_PROMPT,
  SessionConfig
} from "./shared/constants.js";
import { ProcessedDeepgramTTS } from "./tts/processedDeepgramTts.js";

interface WorkerUserData {
  vad?: VAD;
}

function parseConfig(metadata: string): SessionConfig {
  try {
    const parsed = JSON.parse(metadata) as Partial<SessionConfig>;
    return {
      voice: typeof parsed.voice === "string" && parsed.voice ? parsed.voice : DEFAULT_VOICE,
      speed: typeof parsed.speed === "number" ? parsed.speed : DEFAULT_SPEED
    };
  } catch {
    return {
      voice: DEFAULT_VOICE,
      speed: DEFAULT_SPEED
    };
  }
}

const env = getEnv();

async function prewarm(proc: JobProcess): Promise<void> {
  const userData = proc.userData as WorkerUserData;
  userData.vad = await VAD.load();
}

async function entry(ctx: JobContext): Promise<void> {
  const config = parseConfig(ctx.job.metadata);
  const userData = ctx.proc.userData as WorkerUserData;

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

  const session = new voice.AgentSession({
    vad: userData.vad,
    stt: new STTv2({
      apiKey: env.deepgramApiKey,
      model: "flux-general-en",
      sampleRate: 16000
    }),
    llm: new OpenAILLM({
      apiKey: env.openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
      model: env.openrouterModel
    }),
    tts: new ProcessedDeepgramTTS({
      apiKey: env.deepgramApiKey,
      model: config.voice,
      speed: config.speed,
      sampleRate: SAMPLE_RATE
    }),
    useTtsAlignedTranscript: false
  });

  const agent = new voice.Agent({
    instructions: SYSTEM_PROMPT
  });

  const closed = new Promise<void>((resolve) => {
    session.on(voice.AgentSessionEventTypes.Close, () => resolve());
  });

  await session.start({
    agent,
    room: ctx.room,
    record: false
  });

  await ctx.waitForParticipant();
  session.generateReply({
    instructions: "Greet the user briefly and invite them to test the voice."
  });

  await closed;
}

const worker = defineAgent({
  prewarm,
  entry
});

export default worker;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: AGENT_NAME,
      wsURL: env.livekitWsUrl,
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret
    })
  );
}
