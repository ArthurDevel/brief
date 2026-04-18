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

const env = getEnv();

async function buildAssistant(): Promise<voice.Agent> {
  const tools = await createComposioTools(env);

  return new voice.Agent({
    instructions: env.livekitAgentInstructions,
    tools
  });
}

async function entry(ctx: JobContext): Promise<void> {
  await ctx.connect();

  const agent = await buildAssistant();
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

  await ctx.waitForParticipant();
  session.generateReply({
    instructions: env.livekitAgentGreeting
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
