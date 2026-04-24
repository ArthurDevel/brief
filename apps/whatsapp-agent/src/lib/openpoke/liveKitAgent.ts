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
import type { VoiceInteractionAgentStore } from "../voiceInteractionAgentStore.js";
import type {
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

export class VoiceOpenPokeLiveKitAgent extends voice.Agent {
  private activeExecutionSnapshot: VoiceExecutionSnapshotDto | null = null;
  private readonly callerContext: WhatsAppCallerContext;
  private readonly env: AgentEnv;
  private readonly interactionAgent: VoiceOpenPokeInteractionAgentRuntime;
  private readonly voiceInteractionAgentStore: VoiceInteractionAgentStore | null;
  private lastFinishedSpeechAt = Date.now();
  private lastSpokenNarrationMessage: string | null = null;
  private latestNarration: VoiceNarrationResultDto | null = null;
  private readonly memoryEntries: MemoryEntry[];
  private narrationLoopGeneration = 0;
  private narrationPlaybackQueued = false;
  private readonly narrationAgent: VoiceOpenPokeNarrationAgent;
  private readonly conversationHistory: VoiceConversationMessageDto[] = [];
  private speechQueue: Promise<void> = Promise.resolve();
  private latestTurnId = 0;

  /**
   * Creates the LiveKit-facing voice agent.
   * @param env - Agent environment config
   * @param callerContext - Caller-scoped runtime context
   * @param interactionAgent - Explicit voice OpenPoke interaction runtime
   * @param narrationAgent - Text-only narration runtime used during execution waits
   * @param memoryEntries - Loaded user memory entries
   * @param conversationHistory - Persisted interaction-agent message history for this call
   * @param voiceInteractionAgentStore - Optional voice interaction-agent store
   */
  constructor(
    env: AgentEnv,
    callerContext: WhatsAppCallerContext,
    interactionAgent: VoiceOpenPokeInteractionAgentRuntime,
    narrationAgent: VoiceOpenPokeNarrationAgent,
    memoryEntries: MemoryEntry[],
    conversationHistory: VoiceConversationMessageDto[],
    voiceInteractionAgentStore: VoiceInteractionAgentStore | null
  ) {
    super({
      instructions: "WhatsApp voice OpenPoke runtime",
    });

    this.env = env;
    this.callerContext = callerContext;
    this.interactionAgent = interactionAgent;
    this.narrationAgent = narrationAgent;
    this.memoryEntries = memoryEntries;
    this.voiceInteractionAgentStore = voiceInteractionAgentStore;
    this.conversationHistory.push(...conversationHistory);
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
        recordAsNarratorMessage: false,
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
    const turnId = this.startNewTurn();

    try {
      await this.recordInboundMessage(currentMessage);
      await startActiveObservation(
        WHATSAPP_VOICE_TRACE_NAME,
        async (turnObservation) => {
          turnObservation.update({
            input: {
              text: turn.currentMessage.text,
              turnId,
            },
          });

          await propagateAttributes(
            {
              metadata: {
                channel: "whatsapp_voice",
                feature: "voice_agent",
                turnId: String(turnId),
              },
              sessionId: buildWhatsAppVoiceSessionId(this.callerContext),
              tags: ["whatsapp", "voice-agent"],
              traceName: WHATSAPP_VOICE_TRACE_NAME,
              userId: this.callerContext.supabaseUserId,
            },
            async () => {
              const result = await this.interactionAgent.runTurn(
                turn,
                async (action) => await this.emitActionForTurn(turnId, action),
                {
                  onExecutionSnapshot: async (snapshot) =>
                    await this.handleExecutionSnapshot(turnId, snapshot),
                }
              );

              turnObservation.update({
                output: {
                  actionTypes: result.actions.map((action) => action.type),
                  status: result.status,
                  turnId,
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
        turnId,
      });

      if (this.isCurrentTurn(turnId)) {
        await this.speakText(GENERIC_VOICE_ERROR_MESSAGE, {
          recordAsNarratorMessage: false,
          recordInConversationHistory: true,
        });
      }
    }

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
  private async handleExecutionSnapshot(
    turnId: number,
    snapshot: VoiceExecutionSnapshotDto
  ): Promise<void> {
    if (!this.isCurrentTurn(turnId)) {
      return;
    }

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
   * Starts one new user turn and clears stale execution state.
   * @returns New turn ID
   */
  private startNewTurn(): number {
    this.latestTurnId += 1;
    this.activeExecutionSnapshot = null;
    this.latestNarration = null;
    this.stopNarrationLoop();

    return this.latestTurnId;
  }

  /**
   * Returns whether the supplied turn is still the newest user turn.
   * @param turnId - Candidate turn ID
   * @returns True when the turn is still current
   */
  private isCurrentTurn(turnId: number): boolean {
    return turnId === this.latestTurnId;
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
            recordAsNarratorMessage: false,
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
   * Executes one user-visible interaction action only when the turn is still current.
   * @param turnId - Turn that owns the action
   * @param action - User-visible action returned by the interaction runtime
   * @returns Nothing
   */
  private async emitActionForTurn(
    turnId: number,
    action: VoiceUserVisibleActionDto
  ): Promise<void> {
    if (!this.isCurrentTurn(turnId)) {
      return;
    }

    await this.emitAction(action);
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
      recordAsNarratorMessage: true,
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
      recordAsNarratorMessage: boolean;
      recordInConversationHistory: boolean;
    }
  ): Promise<void> {
    const nextSpeech = this.speechQueue.then(async () => {
      await this.session.say(text).waitForPlayout();
      this.lastFinishedSpeechAt = Date.now();

      if (options.recordInConversationHistory) {
        await this.recordOutboundMessage(text);
      } else if (options.recordAsNarratorMessage) {
        await this.recordNarratorMessage(text);
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
  private async recordInboundMessage(
    message: VoiceConversationMessageDto
  ): Promise<void> {
    if (!this.voiceInteractionAgentStore) {
      this.conversationHistory.push(message);
      return;
    }

    const storedMessage = await this.voiceInteractionAgentStore.appendVoiceInteractionAgentMessage({
      role: "user",
      text: message.text,
    });
    this.conversationHistory.push(storedMessage);
  }

  /**
   * Records one outbound assistant message in conversation history.
   * @param text - Spoken assistant message
   * @returns Nothing
   */
  private async recordOutboundMessage(text: string): Promise<void> {
    if (!this.voiceInteractionAgentStore) {
      this.conversationHistory.push({
        createdAt: new Date().toISOString(),
        direction: "outbound",
        text,
      });
      return;
    }

    const storedMessage = await this.voiceInteractionAgentStore.appendVoiceInteractionAgentMessage({
      role: "assistant",
      text,
    });
    this.conversationHistory.push(storedMessage);
  }

  /**
   * Persists one spoken narrator message without adding it to prompt history.
   * @param text - Spoken narrator message
   * @returns Nothing
   */
  private async recordNarratorMessage(text: string): Promise<void> {
    if (!this.voiceInteractionAgentStore) {
      return;
    }

    await this.voiceInteractionAgentStore.appendVoiceNarratorMessage({
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
