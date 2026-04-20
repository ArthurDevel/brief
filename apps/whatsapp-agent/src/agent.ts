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
import { buildAssistantInstructions } from "./lib/assistantInstructions.js";
import {
  createComposioSession,
  createComposioTools,
  type ComposioUserSession
} from "./lib/composio.js";
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
import { getLastCallEndedAt } from "./lib/lastCall.js";
import { buildGmailContextLine } from "./lib/gmailContext.js";
import { buildSystemPrompt, type SessionContext } from "./lib/promptBuilder.js";
import { getUserMemoryEntries, type MemoryEntry } from "./lib/memory.js";

const env = getEnv();

// ============================================================================
// CONSTANTS
// ============================================================================

const KNOWN_STT_REJECTION_MESSAGE_PREFIX = "failed to recognize speech after";
const KNOWN_STT_REJECTION_STACK_FRAGMENT = "SpeechStream.mainTask";
const KNOWN_STT_ABORTED_ERROR_MESSAGE = "WebSocket connection aborted";
const KNOWN_STT_ERROR_LABEL = "inference.STT";
const KNOWN_UNHANDLED_ERROR_CODE = "ERR_UNHANDLED_ERROR";

// Toolkit slug used to detect Gmail connectivity for context injection.
const GMAIL_TOOLKIT_SLUG = "gmail";

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
 * @param composioSession - Composio user session for tool execution
 * @param instructions - Composed system prompt (base + injected context sections)
 * @returns Voice agent + voice config to use for the session
 */
async function buildAssistant(
  callerContext: WhatsAppCallerContext,
  composioSession: ComposioUserSession,
  instructions: string
): Promise<BuiltAssistant> {
  const startedAt = Date.now();
  console.info("[whatsapp-agent] buildAssistant start", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitCount: Object.keys(callerContext.connectedAccountsByToolkit).length,
    hasConnectionGuidanceMessage: Boolean(callerContext.connectionGuidanceMessage),
  });

  const tools = await createComposioTools(env, callerContext, composioSession);
  console.info("[whatsapp-agent] composio tools created", {
    toolCount: Object.keys(tools).length,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    agent: new voice.Agent({
      instructions,
      tools
    }),
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

    // Look up the user's last completed call so we can mention "since last call"
    // counts in the greeting. Soft-fail: a missing value just means we treat this
    // as a first call.
    let lastCallEndedAt: Date | null = null;
    try {
      lastCallEndedAt = await getLastCallEndedAt(env, callerContext.supabaseUserId);
      console.info("[whatsapp-agent] last call lookup complete", {
        supabaseUserId: callerContext.supabaseUserId,
        hasLastCall: lastCallEndedAt !== null,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.warn("[whatsapp-agent] failed to fetch last call end time, treating as first call", {
        supabaseUserId: callerContext.supabaseUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Load the user's saved memory entries for injection into the system prompt.
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

    // Create the Composio user session up-front so it can be reused by both the
    // greeting context fetch (e.g. Gmail unread count) and the LLM tool wrappers.
    const composioSession = await createComposioSession(env, callerContext);

    // Build the email context line only if Gmail is one of the connected toolkits.
    // Soft-fail: an API hiccup must not block the call from starting.
    let emailContext: string | null = null;
    if (GMAIL_TOOLKIT_SLUG in callerContext.connectedAccountsByToolkit) {
      try {
        emailContext = await buildGmailContextLine(composioSession, lastCallEndedAt);
        console.info("[whatsapp-agent] gmail context line built", {
          supabaseUserId: callerContext.supabaseUserId,
          hasContext: emailContext !== null,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        console.warn("[whatsapp-agent] failed to build gmail context line, continuing without it", {
          supabaseUserId: callerContext.supabaseUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sessionContext: SessionContext = {
      currentDateTime: new Date().toISOString(),
      lastCallDateTime: lastCallEndedAt?.toISOString() ?? null,
    };

    const baseInstructions = buildAssistantInstructions(
      env.livekitAgentInstructions,
      callerContext
    );
    const instructions = buildSystemPrompt({
      baseInstructions,
      memoryEntries,
      sessionContext,
      emailContext,
    });
    console.info("[whatsapp-agent] system prompt built", {
      supabaseUserId: callerContext.supabaseUserId,
      promptChars: instructions.length,
      memoryEntryCount: memoryEntries.length,
      hasEmailContext: emailContext !== null,
      elapsedMs: Date.now() - startedAt,
    });

    const builtAssistant = await buildAssistant(callerContext, composioSession, instructions);
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
    llm: env.livekitLlmModel,
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
