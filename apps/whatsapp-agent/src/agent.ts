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
import {
  resolveWhatsAppCallerContext,
  type WhatsAppCallerContext
} from "./lib/whatsappRuntime.js";
import {
  createWhatsAppSession,
  finalizeWhatsAppSession
} from "./lib/sessionStore.js";
import { notifyWhatsAppEndOfSession } from "./lib/webApp.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const KNOWN_STT_REJECTION_MESSAGE_PREFIX = "failed to recognize speech after";
const KNOWN_STT_REJECTION_STACK_FRAGMENT = "SpeechStream.mainTask";

// ============================================================================
// MAIN ENTRYPOINT HELPERS
// ============================================================================

/**
 * Registers a narrow unhandled-rejection guard for the known LiveKit STT shutdown bug.
 * @returns Void
 */
function registerUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    if (isIgnorableSttShutdownRejection(reason)) {
      console.warn("[whatsapp-agent] ignoring known STT shutdown rejection", {
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return;
    }

    setImmediate(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  });
}

/**
 * Returns true when the rejection matches the known LiveKit STT shutdown error.
 * @param reason - Unhandled rejection reason from Node.js
 * @returns True when the rejection is safe to ignore
 */
function isIgnorableSttShutdownRejection(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }

  const hasKnownMessage = reason.message.startsWith(KNOWN_STT_REJECTION_MESSAGE_PREFIX);
  const hasKnownStack =
    typeof reason.stack === "string" && reason.stack.includes(KNOWN_STT_REJECTION_STACK_FRAGMENT);

  return hasKnownMessage && hasKnownStack;
}

const env = getEnv();

registerUnhandledRejectionHandler();

async function buildAssistant(callerContext: WhatsAppCallerContext): Promise<voice.Agent> {
  const startedAt = Date.now();
  console.info("[whatsapp-agent] buildAssistant start", {
    supabaseUserId: callerContext.supabaseUserId,
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
  let callerContext: WhatsAppCallerContext | null = null;
  let appSessionId: string | null = null;
  const sessionStartedAt = new Date();

  try {
    callerContext = await resolveWhatsAppCallerContext(env, participant.metadata);
    console.info("[whatsapp-agent] caller context resolved", {
      supabaseUserId: callerContext.supabaseUserId,
      toolkitCount: Object.keys(callerContext.connectedAccountsByToolkit).length,
      elapsedMs: Date.now() - startedAt,
    });

    try {
      appSessionId = await createWhatsAppSession(
        env,
        callerContext.supabaseUserId,
        sessionStartedAt
      );
      console.info("[whatsapp-agent] session row created", {
        sessionId: appSessionId,
        supabaseUserId: callerContext.supabaseUserId,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("[whatsapp-agent] failed to create session row", {
        supabaseUserId: callerContext.supabaseUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    agent = await buildAssistant(callerContext);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "I could not reach your connected tools. Send authenticate overview in WhatsApp and try again.";

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

  try {
    await closed;
    console.info("[whatsapp-agent] session closed", {
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    if (appSessionId) {
      const sessionEndedAt = new Date();

      try {
        await finalizeWhatsAppSession(
          env,
          appSessionId,
          session,
          sessionStartedAt,
          sessionEndedAt
        );
        console.info("[whatsapp-agent] session row finalized", {
          sessionId: appSessionId,
          elapsedMs: Date.now() - startedAt,
        });

        void notifyWhatsAppEndOfSession(env, appSessionId).catch((error) => {
          console.error("[whatsapp-agent] whatsapp-end-of-session callback failed", {
            sessionId: appSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        console.error("[whatsapp-agent] failed to finalize session row", {
          sessionId: appSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
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
