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
  const startedAt = Date.now();
  console.info("[whatsapp-agent] buildAssistant start", {
    participantMetadataLength: participantMetadata.length,
  });

  const callerContext = await resolveWhatsAppCallerContext(env, participantMetadata);
  console.info("[whatsapp-agent] caller context resolved", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitCount: Object.keys(callerContext.connectedAccountsByToolkit).length,
    elapsedMs: Date.now() - startedAt,
  });

  const tools = await createComposioTools(env, callerContext);
  console.info("[whatsapp-agent] composio tools created", {
    toolCount: Object.keys(tools).length,
    elapsedMs: Date.now() - startedAt,
  });

  return new voice.Agent({
    instructions: env.livekitAgentInstructions,
    tools
  });
}

async function entry(ctx: JobContext): Promise<void> {
  const startedAt = Date.now();
  console.info("[whatsapp-agent] entry start");

  await ctx.connect();
  console.info("[whatsapp-agent] ctx.connect complete", {
    elapsedMs: Date.now() - startedAt,
  });

  const participant = await ctx.waitForParticipant();
  console.info("[whatsapp-agent] participant joined", {
    participantIdentity: participant.identity,
    metadataLength: participant.metadata.length,
    elapsedMs: Date.now() - startedAt,
  });

  let agent: voice.Agent;
  let greeting = env.livekitAgentGreeting;

  try {
    agent = await buildAssistant(participant.metadata);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "I could not reach your connected apps. Send authenticate gmail in WhatsApp and try again.";

    console.error("[whatsapp-agent] failed to resolve caller context", {
      participantIdentity: participant.identity,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
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

  console.info("[whatsapp-agent] session.start begin", {
    elapsedMs: Date.now() - startedAt,
  });
  await session.start({
    agent,
    room: ctx.room,
    record: false
  });
  console.info("[whatsapp-agent] session.start complete", {
    elapsedMs: Date.now() - startedAt,
  });

  console.info("[whatsapp-agent] generateReply begin", {
    elapsedMs: Date.now() - startedAt,
  });
  session.generateReply({
    instructions: greeting
  });
  console.info("[whatsapp-agent] generateReply queued", {
    elapsedMs: Date.now() - startedAt,
  });

  await closed;
  console.info("[whatsapp-agent] session closed", {
    elapsedMs: Date.now() - startedAt,
  });
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
