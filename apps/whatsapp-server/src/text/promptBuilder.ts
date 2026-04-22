/**
 * Prompt builders for the WhatsApp text interaction and execution agents.
 *
 * Responsibilities:
 * - Build the OpenPoke-style interaction prompt for WhatsApp text turns
 * - Build the execution-agent prompt used for real tool execution
 * - Render WhatsApp conversation history into tagged prompt sections
 */

import type { WhatsAppConversationMessageDto } from "@dublin/whatsapp-core";
import type { PreparedTextTurnDto } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const EMPTY_SECTION_VALUE = "None";

const WHATSAPP_INTERACTION_SYSTEM_PROMPT = [
  "You are OpenPoke on WhatsApp text.",
  "You are the interaction agent for this WhatsApp text channel.",
  "Always communicate with the user through the available tools. Do not reply with plain assistant text instead of a tool call.",
  "Use send_message_to_agent whenever a task needs external app access, lookup, or execution.",
  "In this WhatsApp text runtime, send_message_to_agent returns the execution agent result in the tool output during the same turn.",
  "Always send the user a short status update with send_message_to_user before you call send_message_to_agent.",
  "Always check the conversation history and use wait if you would otherwise repeat the same message, draft, or confirmation.",
  "Use send_draft when the user asks to send, reply, or forward email content. Draft first, then ask for confirmation.",
  "Never claim that a draft was sent or an external action was completed unless the execution result explicitly says so.",
  "The WhatsApp text flow still keeps explicit auth commands as a fast path outside this runtime.",
  "Keep user-facing WhatsApp messages concise, natural, and useful.",
  "Do not use emojis unless the user already used them.",
].join("\n\n");

const WHATSAPP_EXECUTION_SYSTEM_PROMPT = [
  "You are the WhatsApp text execution agent.",
  "You execute tasks for the interaction agent and do not talk to the user directly.",
  "Use the available tools to complete the task. If a requested app is not connected, use the WhatsApp auth tools when available instead of pretending the task succeeded.",
  "Never send or execute a draft without explicit confirmation from the user.",
  "Your final response is for the interaction agent. Be direct and include exact draft fields when you create a draft.",
].join("\n\n");

const WHATSAPP_EXECUTION_FAILURE_SUMMARIZER_SYSTEM_PROMPT = [
  "You are the WhatsApp text execution agent.",
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
 * Returns the interaction-agent system prompt for WhatsApp text.
 * @returns Interaction-agent system prompt
 */
export function buildWhatsAppTextSystemPrompt(): string {
  return WHATSAPP_INTERACTION_SYSTEM_PROMPT;
}

/**
 * Returns the execution-agent system prompt for one named agent.
 * @param agentName - Human-readable execution agent name
 * @param connectedToolkits - Connected toolkit slugs available to the caller
 * @returns Execution-agent system prompt
 */
export function buildWhatsAppExecutionSystemPrompt(
  agentName: string,
  connectedToolkits: string[]
): string {
  const connectionSummary = connectedToolkits.length > 0
    ? `Connected apps for this WhatsApp user: ${connectedToolkits.join(", ")}.`
    : "This WhatsApp user does not currently have any connected apps.";

  return [
    WHATSAPP_EXECUTION_SYSTEM_PROMPT,
    `Agent Name: ${agentName}`,
    connectionSummary,
  ].join("\n\n");
}

/**
 * Returns the fallback summarizer prompt for failed execution runs.
 * @param agentName - Human-readable execution agent name
 * @returns Execution-failure summarizer system prompt
 */
export function buildWhatsAppExecutionFailureSummarizerSystemPrompt(
  agentName: string
): string {
  return [
    WHATSAPP_EXECUTION_FAILURE_SUMMARIZER_SYSTEM_PROMPT,
    `Agent Name: ${agentName}`,
  ].join("\n\n");
}

/**
 * Builds the tagged user message for one WhatsApp interaction turn.
 * @param turn - Prepared conversation turn
 * @returns One user message content string
 */
export function buildWhatsAppTextUserPrompt(turn: PreparedTextTurnDto): string {
  const sections = [
    buildChannelContextSection(turn),
    buildMemorySection(turn),
    buildConversationHistorySection(turn.conversationHistory),
    `<new_user_message>\n${escapePromptText(turn.currentMessage.text)}\n</new_user_message>`,
  ];

  return sections.join("\n\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Renders basic channel context for the current turn.
 * @param turn - Prepared conversation turn
 * @returns Tagged channel-context section
 */
function buildChannelContextSection(turn: PreparedTextTurnDto): string {
  return [
    "<channel_context>",
    "- Channel: WhatsApp text",
    `- Current date/time: ${new Date().toISOString()}`,
    `- Linked WhatsApp phone: ${turn.linkedUser.whatsappPhone}`,
    "</channel_context>",
  ].join("\n");
}

/**
 * Renders user memory entries into one tagged block.
 * @param turn - Prepared conversation turn
 * @returns Tagged memory section
 */
function buildMemorySection(turn: PreparedTextTurnDto): string {
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
 * @param messages - Recent WhatsApp conversation messages
 * @returns Tagged history section
 */
function buildConversationHistorySection(
  messages: WhatsAppConversationMessageDto[]
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
 * @param message - One stored WhatsApp message
 * @returns Tagged conversation entry
 */
function renderConversationMessage(message: WhatsAppConversationMessageDto): string {
  const tag = message.direction === "inbound" ? "user_message" : "poke_reply";
  const timestamp = escapePromptText(message.createdAt);
  const body = escapePromptText(message.text);

  return `<${tag} timestamp="${timestamp}">\n${body}\n</${tag}>`;
}

/**
 * Escapes XML-like prompt text so prompt wrappers stay valid.
 * @param value - Raw user or assistant text
 * @returns Prompt-safe text
 */
function escapePromptText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
