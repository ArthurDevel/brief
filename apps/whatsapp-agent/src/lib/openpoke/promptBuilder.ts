/**
 * Prompt builders for the WhatsApp voice OpenPoke runtimes.
 *
 * Responsibilities:
 * - Build the OpenPoke-style interaction prompt for WhatsApp voice turns
 * - Build the execution-agent prompt used for real tool execution
 * - Render voice conversation history into the same tagged structure as text
 */

import type { PreparedVoiceTurnDto, VoiceConversationMessageDto } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const EMPTY_SECTION_VALUE = "None";
const MAX_CONVERSATION_MESSAGES_IN_PROMPT = 20;
const MAX_HISTORY_MESSAGES_BEFORE_CURRENT = MAX_CONVERSATION_MESSAGES_IN_PROMPT - 1;

const WHATSAPP_VOICE_INTERACTION_SYSTEM_PROMPT = [
  "You are OpenPoke on WhatsApp voice.",
  "You are the interaction agent for this WhatsApp voice channel.",
  "Always communicate with the user through the available tools. Do not reply with plain assistant text instead of a tool call.",
  "Use send_message_to_agent whenever a task needs external app access, lookup, or execution.",
  "Use send_whatsapp_auth_template when the user asks to connect Gmail, Google Calendar, Notion, or Outlook, or when it is clear the requested app is not connected.",
  "Use send_whatsapp_connector_overview when the user needs a general setup, reconnect, or connector review flow.",
  "In this WhatsApp voice runtime, send_message_to_agent returns the execution agent result in the tool output during the same turn.",
  "Always send the user a short status update with send_message_to_user before you call send_message_to_agent.",
  "After you send a WhatsApp auth template or connector overview, follow up with send_message_to_user unless the template already fully explains the next step.",
  "Always check the conversation history and use wait if you would otherwise repeat the same message or confirmation.",
  "Never claim that an external action was completed unless the execution result explicitly says so.",
  "Keep user-facing WhatsApp voice messages concise, natural, and useful.",
  "Do not use emojis unless the user already used them.",
].join("\n\n");

const WHATSAPP_VOICE_EXECUTION_SYSTEM_PROMPT = [
  "You are the WhatsApp voice execution agent.",
  "You execute tasks for the interaction agent and do not talk to the user directly.",
  "Use the available tools to complete the task. If a requested app is not connected, use the WhatsApp auth tools when available instead of pretending the task succeeded.",
  "Never send or execute a draft without explicit confirmation from the user.",
  "Your final response is for the interaction agent. Be direct and include exact next steps when relevant.",
].join("\n\n");

const WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_SYSTEM_PROMPT = [
  "You are the WhatsApp voice execution agent.",
  "You are summarizing a failed execution attempt for the interaction agent.",
  "Your final output is directed to the interaction agent, not the end user.",
  "Use the provided execution trace only. Do not invent tool results or completed actions.",
  "Explain briefly what the agent attempted, what the latest tool activity shows, and why the task did not finish.",
  "If the trace suggests the agent got stuck in a loop, say so plainly.",
  "Avoid preamble and postamble. Return one concise natural-language summary.",
].join("\n\n");

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the interaction-agent system prompt for WhatsApp voice.
 * @returns Interaction-agent system prompt
 */
export function buildVoiceOpenPokeInteractionSystemPrompt(): string {
  return WHATSAPP_VOICE_INTERACTION_SYSTEM_PROMPT;
}

/**
 * Returns the execution-agent system prompt for one named agent.
 * @param agentName - Human-readable execution agent name
 * @param connectedToolkits - Connected toolkit slugs available to the caller
 * @returns Execution-agent system prompt
 */
export function buildVoiceOpenPokeExecutionSystemPrompt(
  agentName: string,
  connectedToolkits: string[]
): string {
  const connectionSummary = connectedToolkits.length > 0
    ? `Connected apps for this WhatsApp user: ${connectedToolkits.join(", ")}.`
    : "This WhatsApp user does not currently have any connected apps.";

  return [
    WHATSAPP_VOICE_EXECUTION_SYSTEM_PROMPT,
    `Agent Name: ${agentName}`,
    connectionSummary,
  ].join("\n\n");
}

/**
 * Returns the failure-summarizer prompt for one execution agent.
 * @param agentName - Human-readable execution agent name
 * @returns Failure summarizer system prompt
 */
export function buildVoiceOpenPokeExecutionFailureSummarizerSystemPrompt(
  agentName: string
): string {
  return [
    WHATSAPP_VOICE_EXECUTION_FAILURE_SUMMARIZER_SYSTEM_PROMPT,
    `Agent Name: ${agentName}`,
  ].join("\n\n");
}

/**
 * Builds the tagged user message for one WhatsApp voice interaction turn.
 * @param turn - Prepared voice turn
 * @returns One user message content string
 */
export function buildVoiceOpenPokeInteractionUserPrompt(
  turn: PreparedVoiceTurnDto
): string {
  const recentConversationHistory = turn.conversationHistory.slice(
    -MAX_HISTORY_MESSAGES_BEFORE_CURRENT
  );
  const sections = [
    buildChannelContextSection(turn),
    buildMemorySection(turn),
    buildConversationHistorySection(recentConversationHistory),
    `<new_user_message>\n${escapePromptText(turn.currentMessage.text)}\n</new_user_message>`,
  ];

  return sections.join("\n\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Renders basic channel context for the current turn.
 * @param turn - Prepared voice turn
 * @returns Tagged channel-context section
 */
function buildChannelContextSection(turn: PreparedVoiceTurnDto): string {
  return [
    "<channel_context>",
    "- Channel: WhatsApp voice",
    `- Current date/time: ${new Date().toISOString()}`,
    `- Linked WhatsApp phone: ${turn.callerContext.callerPhone}`,
    "</channel_context>",
  ].join("\n");
}

/**
 * Renders user memory entries into one tagged block.
 * @param turn - Prepared voice turn
 * @returns Tagged memory section
 */
function buildMemorySection(turn: PreparedVoiceTurnDto): string {
  if (turn.memoryEntries.length === 0) {
    return `<user_memory>\n${EMPTY_SECTION_VALUE}\n</user_memory>`;
  }

  const memoryLines = turn.memoryEntries
    .map((entry) => `- ${escapePromptText(entry.content)}`)
    .join("\n");

  return `<user_memory>\n${memoryLines}\n</user_memory>`;
}

/**
 * Renders recent conversation history into OpenPoke-style message tags.
 * @param messages - Recent conversation messages
 * @returns Tagged history section
 */
function buildConversationHistorySection(
  messages: VoiceConversationMessageDto[]
): string {
  if (messages.length === 0) {
    return `<conversation_history>\n${EMPTY_SECTION_VALUE}\n</conversation_history>`;
  }

  const renderedMessages = messages
    .map((message) => renderConversationMessage(message))
    .join("\n");

  return `<conversation_history>\n${renderedMessages}\n</conversation_history>`;
}

/**
 * Renders one conversation row into a prompt tag.
 * @param message - One stored conversation message
 * @returns Tagged conversation entry
 */
function renderConversationMessage(message: VoiceConversationMessageDto): string {
  const tag = message.direction === "inbound" ? "user_message" : "poke_reply";
  const timestamp = escapePromptText(message.createdAt);
  const body = escapePromptText(message.text);

  return `<${tag} timestamp="${timestamp}">\n${body}\n</${tag}>`;
}

/**
 * Escapes XML-like prompt text so prompt wrappers stay valid.
 * @param value - Raw text
 * @returns Prompt-safe text
 */
function escapePromptText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
