/**
 * LiveKit-facing voice agent that delegates interaction logic to the explicit
 * voice OpenPoke runtime.
 *
 * Responsibilities:
 * - Receive finalized user transcripts from LiveKit
 * - Build text-style OpenPoke turns for the interaction runtime
 * - Speak only the user-visible actions returned by the interaction runtime
 */

import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { llm, voice } from "@livekit/agents";
import type { WhatsAppCallerContext } from "../whatsappRuntime.js";
import type { MemoryEntry } from "../memory.js";
import {
  sendWhatsAppConnectorAuthTemplate,
  sendWhatsAppConnectorOverviewTemplate,
} from "../whatsappCustomTools.js";
import type { AgentEnv } from "../env.js";
import type {
  VoiceExecutionObserver,
  VoiceExecutionSnapshotDto,
  VoiceNarrationResultDto,
  VoiceOpenPokeNarrationAgent,
} from "./narrationTypes.js";
import type {
  PreparedVoiceTurnDto,
  VoiceConversationMessageDto,
  VoiceUserVisibleActionDto,
} from "./types.js";
import type { VoiceOpenPokeInteractionAgentRuntime } from "./interactionAgent.js";
import {
  buildWhatsAppVoiceSessionId,
  WHATSAPP_VOICE_TRACE_NAME,
} from "../../tracing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const GENERIC_VOICE_ERROR_MESSAGE = "Something went wrong. Please try again.";
const NARRATION_REFRESH_INTERVAL_MS = 2000;
const NARRATION_SILENCE_THRESHOLD_MS = 2000;

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeLiveKitAgent extends voice.Agent implements VoiceExecutionObserver {
  private activeExecutionSnapshot: VoiceExecutionSnapshotDto | null = null;
  private readonly callerContext: WhatsAppCallerContext;
  private readonly env: AgentEnv;
  private readonly interactionAgent: VoiceOpenPokeInteractionAgentRuntime;
  private lastFinishedSpeechAt = Date.now();
  private lastSpokenNarrationMessage: string | null = null;
  private latestNarration: VoiceNarrationResultDto | null = null;
  private readonly memoryEntries: MemoryEntry[];
  private narrationLoopGeneration = 0;
  private narrationPlaybackQueued = false;
  private readonly narrationAgent: VoiceOpenPokeNarrationAgent;
  private readonly conversationHistory: VoiceConversationMessageDto[] = [];
  private pendingTurn: Promise<void> = Promise.resolve();
  private speechQueue: Promise<void> = Promise.resolve();

  /**
   * Creates the LiveKit-facing voice agent.
   * @param env - Agent environment config
   * @param callerContext - Caller-scoped runtime context
   * @param interactionAgent - Explicit voice OpenPoke interaction runtime
   * @param narrationAgent - Text-only narration runtime used during execution waits
   * @param memoryEntries - Loaded user memory entries
   */
  constructor(
    env: AgentEnv,
    callerContext: WhatsAppCallerContext,
    interactionAgent: VoiceOpenPokeInteractionAgentRuntime,
    narrationAgent: VoiceOpenPokeNarrationAgent,
    memoryEntries: MemoryEntry[]
  ) {
    super({
      instructions: "WhatsApp voice OpenPoke runtime",
    });

    this.env = env;
    this.callerContext = callerContext;
    this.interactionAgent = interactionAgent;
    this.narrationAgent = narrationAgent;
    this.memoryEntries = memoryEntries;
  }

  /**
   * Speaks the initial greeting and records it in conversation history.
   * @returns Nothing
   */
  override async onEnter(): Promise<void> {
    try {
      await this.interactionAgent.runConversationStart(
        {
          callerContext: this.callerContext,
          conversationHistory: [...this.conversationHistory],
          memoryEntries: this.memoryEntries,
        },
        async (action) => await this.emitAction(action)
      );
    } catch (error) {
      console.error("[whatsapp-agent] initial conversation start failed", {
        callerPhone: this.callerContext.callerPhone,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.speakText(GENERIC_VOICE_ERROR_MESSAGE, {
        recordInConversationHistory: true,
      });
    }
  }

  /**
   * Handles one completed user turn by running the explicit interaction agent.
   * @param _chatCtx - LiveKit chat context, unused in this runtime
   * @param newMessage - Finalized user transcript message
   * @returns Nothing
   */
  override async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage
  ): Promise<void> {
    const transcript = newMessage.textContent?.trim();
    if (!transcript) {
      throw new voice.StopResponse();
    }

    const currentMessage = {
      createdAt: new Date().toISOString(),
      direction: "inbound",
      text: transcript,
    } satisfies VoiceConversationMessageDto;
    const turn: PreparedVoiceTurnDto = {
      callerContext: this.callerContext,
      conversationHistory: [...this.conversationHistory],
      currentMessage,
      memoryEntries: this.memoryEntries,
    };

    this.recordInboundMessage(currentMessage);

    this.pendingTurn = this.pendingTurn.then(async () => {
      try {
        await startActiveObservation(
          WHATSAPP_VOICE_TRACE_NAME,
          async (turnObservation) => {
            turnObservation.update({
              input: {
                text: turn.currentMessage.text,
              },
            });

            await propagateAttributes(
              {
                metadata: {
                  channel: "whatsapp_voice",
                  feature: "voice_agent",
                },
                sessionId: buildWhatsAppVoiceSessionId(this.callerContext),
                tags: ["whatsapp", "voice-agent"],
                traceName: WHATSAPP_VOICE_TRACE_NAME,
                userId: this.callerContext.supabaseUserId,
              },
              async () => {
                const result = await this.interactionAgent.runTurn(
                  turn,
                  async (action) => await this.emitAction(action),
                  this
                );

                turnObservation.update({
                  output: {
                    actionTypes: result.actions.map((action) => action.type),
                    status: result.status,
                  },
                });
              }
            );
          }
        );
      } catch (error) {
        console.error("[whatsapp-agent] voice interaction turn failed", {
          callerPhone: this.callerContext.callerPhone,
          error: error instanceof Error ? error.message : String(error),
          transcript,
        });

        await this.speakText(GENERIC_VOICE_ERROR_MESSAGE, {
          recordInConversationHistory: true,
        });
      }
    });

    await this.pendingTurn;
    throw new voice.StopResponse();
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Receives one read-only execution snapshot from the delegated execution flow.
   * @param snapshot - Current execution snapshot
   * @returns Nothing
   */
  async onExecutionSnapshot(snapshot: VoiceExecutionSnapshotDto): Promise<void> {
    if (snapshot.status === "finished" || snapshot.status === "failed") {
      if (this.activeExecutionSnapshot?.executionId === snapshot.executionId) {
        this.activeExecutionSnapshot = null;
        this.latestNarration = null;
      }

      this.stopNarrationLoop();
      return;
    }

    const isNewExecution = this.activeExecutionSnapshot?.executionId !== snapshot.executionId;
    this.activeExecutionSnapshot = snapshot;

    if (isNewExecution) {
      this.latestNarration = null;
      this.lastSpokenNarrationMessage = null;
      this.stopNarrationLoop();
      this.startNarrationLoop(snapshot.executionId);
    }
  }

  /**
   * Executes one user-visible interaction action.
   * @param action - User-visible action returned by the interaction runtime
   * @returns Nothing
   */
  private async emitAction(action: VoiceUserVisibleActionDto): Promise<void> {
    await startActiveObservation(
      `whatsapp-user-visible-action:${action.type}`,
      async (toolObservation) => {
        toolObservation.update({
          input: {
            actionType: action.type,
            callerPhone: this.callerContext.callerPhone,
            userId: this.callerContext.supabaseUserId,
          },
        });

        if (action.type === "message") {
          await this.speakText(action.message, {
            recordInConversationHistory: true,
          });
          toolObservation.update({
            output: {
              actionType: action.type,
              messageLength: action.message.length,
            },
          });
          return;
        }

        if (action.type === "auth_template") {
          await sendWhatsAppConnectorAuthTemplate(
            this.env,
            this.callerContext.callerPhone,
            action.toolkit
          );
          toolObservation.update({
            output: {
              actionType: action.type,
              toolkit: action.toolkit,
            },
          });
          return;
        }

        if (action.type === "connector_overview") {
          await sendWhatsAppConnectorOverviewTemplate(
            this.env,
            this.callerContext.callerPhone
          );
          toolObservation.update({
            output: {
              actionType: action.type,
            },
          });
          return;
        }

        throw new Error(`Unsupported voice action type: ${(action as { type: string }).type}`);
      },
      {
        asType: "tool",
      }
    );
  }

  /**
   * Starts a background loop that keeps the latest narration sentence fresh.
   * @param executionId - Active execution ID the loop belongs to
   * @returns Nothing
   */
  private startNarrationLoop(executionId: string): void {
    const generation = ++this.narrationLoopGeneration;
    void this.runNarrationLoop(generation, executionId).catch((error) => {
      console.error("[whatsapp-agent] narration loop failed", {
        callerPhone: this.callerContext.callerPhone,
        error: error instanceof Error ? error.message : String(error),
        executionId,
      });
    });
  }

  /**
   * Stops the currently active narration refresh loop.
   * @returns Nothing
   */
  private stopNarrationLoop(): void {
    this.narrationLoopGeneration += 1;
  }

  /**
   * Refreshes buffered narration while one execution is still active.
   * @param generation - Current loop generation
   * @param executionId - Execution ID the loop belongs to
   * @returns Nothing
   */
  private async runNarrationLoop(generation: number, executionId: string): Promise<void> {
    while (this.narrationLoopGeneration === generation) {
      await delay(NARRATION_REFRESH_INTERVAL_MS);
      if (this.narrationLoopGeneration !== generation) {
        return;
      }

      const activeExecution = this.activeExecutionSnapshot;
      if (!activeExecution || activeExecution.executionId !== executionId) {
        return;
      }

      const narration = await this.narrationAgent.generateNarration({
        activeExecution,
        previousNarration: this.latestNarration?.message ?? this.lastSpokenNarrationMessage,
      });
      if (this.narrationLoopGeneration !== generation) {
        return;
      }

      if (narration) {
        this.latestNarration = narration;
      }

      this.maybeSpeakBufferedNarration(executionId);
    }
  }

  /**
   * Speaks the latest buffered narration when the execution wait has gone quiet.
   * @param executionId - Execution ID the buffered narration belongs to
   * @returns Nothing
   */
  private maybeSpeakBufferedNarration(executionId: string): void {
    const activeExecution = this.activeExecutionSnapshot;
    if (!activeExecution || activeExecution.executionId !== executionId) {
      return;
    }

    if (!this.latestNarration?.message) {
      return;
    }

    if (this.latestNarration.message === this.lastSpokenNarrationMessage) {
      return;
    }

    if (this.narrationPlaybackQueued) {
      return;
    }

    if (Date.now() - this.lastFinishedSpeechAt < NARRATION_SILENCE_THRESHOLD_MS) {
      return;
    }

    const narrationMessage = this.latestNarration.message;
    this.narrationPlaybackQueued = true;
    void this.speakText(narrationMessage, {
      recordInConversationHistory: false,
    }).then(() => {
      this.lastSpokenNarrationMessage = narrationMessage;
    }).catch((error) => {
      console.error("[whatsapp-agent] narration speech failed", {
        callerPhone: this.callerContext.callerPhone,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.narrationPlaybackQueued = false;
    });
  }

  /**
   * Queues one spoken text segment through the shared speech path.
   * @param text - Text to speak
   * @param options - Speech options for history recording
   * @returns Nothing
   */
  private async speakText(
    text: string,
    options: {
      recordInConversationHistory: boolean;
    }
  ): Promise<void> {
    const nextSpeech = this.speechQueue.then(async () => {
      await this.session.say(text).waitForPlayout();
      this.lastFinishedSpeechAt = Date.now();

      if (options.recordInConversationHistory) {
        this.recordOutboundMessage(text);
      }
    });

    this.speechQueue = nextSpeech.catch(() => undefined);
    await nextSpeech;
  }

  /**
   * Records one inbound user message in conversation history.
   * @param message - Inbound conversation message
   * @returns Nothing
   */
  private recordInboundMessage(message: VoiceConversationMessageDto): void {
    this.conversationHistory.push(message);
  }

  /**
   * Records one outbound assistant message in conversation history.
   * @param text - Spoken assistant message
   * @returns Nothing
   */
  private recordOutboundMessage(text: string): void {
    this.conversationHistory.push({
      createdAt: new Date().toISOString(),
      direction: "outbound",
      text,
    });
  }
}

/**
 * Waits for one timeout duration.
 * @param durationMs - Delay length in milliseconds
 * @returns Promise that resolves after the timeout
 */
function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
