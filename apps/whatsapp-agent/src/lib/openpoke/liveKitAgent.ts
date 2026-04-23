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

// ============================================================================
// MAIN CLASS
// ============================================================================

export class VoiceOpenPokeLiveKitAgent extends voice.Agent {
  private readonly callerContext: WhatsAppCallerContext;
  private readonly env: AgentEnv;
  private readonly greeting: string;
  private readonly interactionAgent: VoiceOpenPokeInteractionAgentRuntime;
  private readonly memoryEntries: MemoryEntry[];
  private readonly conversationHistory: VoiceConversationMessageDto[] = [];
  private pendingTurn: Promise<void> = Promise.resolve();

  /**
   * Creates the LiveKit-facing voice agent.
   * @param env - Agent environment config
   * @param callerContext - Caller-scoped runtime context
   * @param greeting - Initial greeting to speak when the call starts
   * @param interactionAgent - Explicit voice OpenPoke interaction runtime
   * @param memoryEntries - Loaded user memory entries
   */
  constructor(
    env: AgentEnv,
    callerContext: WhatsAppCallerContext,
    greeting: string,
    interactionAgent: VoiceOpenPokeInteractionAgentRuntime,
    memoryEntries: MemoryEntry[]
  ) {
    super({
      instructions: "WhatsApp voice OpenPoke runtime",
    });

    this.env = env;
    this.callerContext = callerContext;
    this.greeting = greeting;
    this.interactionAgent = interactionAgent;
    this.memoryEntries = memoryEntries;
  }

  /**
   * Speaks the initial greeting and records it in conversation history.
   * @returns Nothing
   */
  override async onEnter(): Promise<void> {
    await this.session.say(this.greeting).waitForPlayout();
    this.recordOutboundMessage(this.greeting);
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
                  async (action) => await this.emitAction(action)
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

        await this.session.say(GENERIC_VOICE_ERROR_MESSAGE).waitForPlayout();
        this.recordOutboundMessage(GENERIC_VOICE_ERROR_MESSAGE);
      }
    });

    await this.pendingTurn;
    throw new voice.StopResponse();
  }

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

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
          await this.session.say(action.message).waitForPlayout();
          this.recordOutboundMessage(action.message);
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
