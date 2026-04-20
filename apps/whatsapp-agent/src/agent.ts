import "dotenv/config";

import { fileURLToPath } from "node:url";
import {
  JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice
} from "@livekit/agents";
import { getEnv } from "./lib/env.js";
import { createComposioTools } from "./lib/composio.js";
import { resolveWhatsAppCallerContext } from "./lib/whatsappRuntime.js";

const env = getEnv();

async function buildAssistant(participantMetadata: string): Promise<voice.Agent> {
  const callerContext = await resolveWhatsAppCallerContext(env, participantMetadata);
  const tools = await createComposioTools(env, callerContext);

  return new voice.Agent({
    instructions: env.livekitAgentInstructions,
    tools
  });
}

async function entry(ctx: JobContext): Promise<void> {
  await ctx.connect();
  const participant = await ctx.waitForParticipant();

  let agent: voice.Agent;
  let greeting = env.livekitAgentGreeting;

  try {
    agent = await buildAssistant(participant.metadata);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "I could not reach your Gmail connection. Send authenticate gmail in WhatsApp and try again.";

    console.error("[whatsapp-agent] failed to resolve caller context", {
      participantIdentity: participant.identity,
      error: message,
    });

    greeting = message;
    agent = new voice.Agent({
      instructions: message,
    });
  }

  const session = new voice.AgentSession({
    stt: env.livekitSttModel,
    llm: env.livekitLlmModel,
    tts: env.livekitTtsModel
  });

  const closed = new Promise<void>((resolve) => {
    session.on(voice.AgentSessionEventTypes.Close, () => resolve());
  });

  await session.start({
    agent,
    room: ctx.room,
    record: false
  });

  session.generateReply({
    instructions: greeting
  });

  await closed;
}

const worker = defineAgent({
  entry
});

export default worker;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.livekitAgentName,
      wsURL: env.livekitWsUrl,
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret
    })
  );
}
