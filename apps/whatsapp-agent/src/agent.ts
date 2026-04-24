import "./instrumentation.js";

import { fileURLToPath } from "node:url";
import {
  JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice
} from "@livekit/agents";
import { getEnv } from "./lib/env.js";
import {
  resolveWhatsAppCallerContext,
  type WhatsAppCallerContext
} from "./lib/whatsappRuntime.js";
import {
  createWhatsAppSession,
  finalizeWhatsAppSession
} from "./lib/sessionStore.js";
import { notifyWhatsAppEndOfSession } from "./lib/webApp.js";
import {
  createWhatsAppTts,
  getDefaultWhatsAppVoiceConfig,
  type WhatsAppVoiceConfig,
} from "./lib/whatsappVoice.js";
import { getUserMemoryEntries, type MemoryEntry } from "./lib/memory.js";
import {
  createVoiceOpenPokeExecutionAgent,
  type VoiceOpenPokeExecutionAgent,
} from "./lib/openpoke/executionAgent.js";
import { createVoiceOpenPokeInteractionAgent } from "./lib/openpoke/interactionAgent.js";
import { VoiceOpenPokeLiveKitAgent } from "./lib/openpoke/liveKitAgent.js";
import { createVoiceOpenPokeNarrationAgent } from "./lib/openpoke/narrationAgent.js";

const env = getEnv();

// ============================================================================
// CONSTANTS
// ============================================================================

const KNOWN_STT_REJECTION_MESSAGE_PREFIX = "failed to recognize speech after";
const KNOWN_STT_REJECTION_STACK_FRAGMENT = "SpeechStream.mainTask";
const KNOWN_STT_ABORTED_ERROR_MESSAGE = "WebSocket connection aborted";
const KNOWN_STT_ERROR_LABEL = "inference.STT";
const KNOWN_UNHANDLED_ERROR_CODE = "ERR_UNHANDLED_ERROR";

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

  if (hasKnownMessage && hasKnownStack) {
    return true;
  }

  return isIgnorableWrappedSttShutdownError(reason);
}

/**
 * Returns true when Node wraps the known STT shutdown error in ERR_UNHANDLED_ERROR.
 * @param reason - Unhandled rejection reason from Node.js
 * @returns True when the wrapped error is safe to ignore
 */
function isIgnorableWrappedSttShutdownError(reason: Error): boolean {
  const wrappedReason = reason as Error & {
    code?: string;
    context?: {
      error?: {
        message?: string;
      };
      label?: string;
      type?: string;
    };
  };

  const isUnhandledError = wrappedReason.code === KNOWN_UNHANDLED_ERROR_CODE;
  const isSttError = wrappedReason.context?.type === "stt_error";
  const hasKnownLabel = wrappedReason.context?.label === KNOWN_STT_ERROR_LABEL;
  const hasKnownInnerMessage =
    wrappedReason.context?.error?.message === KNOWN_STT_ABORTED_ERROR_MESSAGE;
  const hasKnownOuterMessage = wrappedReason.message.includes(KNOWN_STT_ABORTED_ERROR_MESSAGE);
  const hasKnownStack =
    typeof wrappedReason.stack === "string"
    && wrappedReason.stack.includes(KNOWN_STT_REJECTION_STACK_FRAGMENT);

  return isUnhandledError
    && isSttError
    && hasKnownLabel
    && hasKnownInnerMessage
    && hasKnownOuterMessage
    && hasKnownStack;
}

registerUnhandledRejectionHandler();

interface BuiltAssistant {
  agent: voice.Agent;
  voiceConfig: WhatsAppVoiceConfig;
}

/**
 * Builds the LiveKit voice agent with caller-scoped tools and a composed prompt.
 * @param callerContext - Resolved caller context (toolkits, voice config)
 * @param executionAgent - Voice execution agent used for delegated work
 * @param memoryEntries - Loaded user memory entries
 * @returns Voice agent + voice config to use for the session
 */
async function buildAssistant(
  callerContext: WhatsAppCallerContext,
  executionAgent: VoiceOpenPokeExecutionAgent,
  memoryEntries: MemoryEntry[]
): Promise<BuiltAssistant> {
  const interactionAgent = createVoiceOpenPokeInteractionAgent(env, executionAgent);
  const narrationAgent = createVoiceOpenPokeNarrationAgent(env);

  return {
    agent: new VoiceOpenPokeLiveKitAgent(
      env,
      callerContext,
      interactionAgent,
      narrationAgent,
      memoryEntries
    ),
    voiceConfig: callerContext.voiceConfig
  };
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
  let voiceConfig = getDefaultWhatsAppVoiceConfig();

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

    // Load the user's saved memory entries for prompt injection.
    // Soft-fail: a lookup failure should not block the call from starting.
    let memoryEntries: MemoryEntry[] = [];
    try {
      memoryEntries = await getUserMemoryEntries(env, callerContext.supabaseUserId);
      console.info("[whatsapp-agent] user memory loaded", {
        supabaseUserId: callerContext.supabaseUserId,
        entryCount: memoryEntries.length,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.warn("[whatsapp-agent] failed to load user memory, continuing without it", {
        supabaseUserId: callerContext.supabaseUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const executionAgent = createVoiceOpenPokeExecutionAgent(env);
    const builtAssistant = await buildAssistant(
      callerContext,
      executionAgent,
      memoryEntries
    );
    console.info("[whatsapp-agent] interaction agent built", {
      supabaseUserId: callerContext.supabaseUserId,
      memoryEntryCount: memoryEntries.length,
      elapsedMs: Date.now() - startedAt,
    });
    agent = builtAssistant.agent;
    voiceConfig = builtAssistant.voiceConfig;
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
    tts: createWhatsAppTts(env.deepgramApiKey, voiceConfig)
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

  if (!(agent instanceof VoiceOpenPokeLiveKitAgent)) {
    await session.say(greeting).waitForPlayout();
  }

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

        try {
          await notifyWhatsAppEndOfSession(env, appSessionId);
          console.info("[whatsapp-agent] whatsapp-end-of-session callback completed", {
            sessionId: appSessionId,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          console.error("[whatsapp-agent] whatsapp-end-of-session callback failed", {
            sessionId: appSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

/**
 * Starts the LiveKit worker CLI for this agent.
 * @returns Void
 */
export function runWorkerApp(): void {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorkerApp();
}
