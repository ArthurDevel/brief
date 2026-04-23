/**
 * LiveKit-facing voice agent that delegates interaction logic to the explicit
 * voice OpenPoke runtime.
 *
 * Responsibilities:
 * - Receive finalized user transcripts from LiveKit
 * - Build text-style OpenPoke turns for the interaction runtime
 * - Speak only the user-visible actions returned by the interaction runtime
 */

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
        await this.interactionAgent.runTurn(
          turn,
          async (action) => await this.emitAction(action)
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
    if (action.type === "message") {
      await this.session.say(action.message).waitForPlayout();
      this.recordOutboundMessage(action.message);
      return;
    }

    if (action.type === "auth_template") {
      await sendWhatsAppConnectorAuthTemplate(
        this.env,
        this.callerContext.callerPhone,
        action.toolkit
      );
      return;
    }

    if (action.type === "connector_overview") {
      await sendWhatsAppConnectorOverviewTemplate(
        this.env,
        this.callerContext.callerPhone
      );
      return;
    }

    throw new Error(`Unsupported voice action type: ${(action as { type: string }).type}`);
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
