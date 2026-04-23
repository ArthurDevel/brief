/**
 * Assembles the WhatsApp agent system prompt from labeled sections.
 *
 * Responsibilities:
 * - Compose base instructions plus optional context sections
 * - Keep a stable section layout for memory, session context, and email context
 * - Provide a single place to grow as new context types are introduced
 */

import type { MemoryEntry } from "./memory.js";

// ============================================================================
// TYPES
// ============================================================================

export interface SessionContext {
  currentDateTime: string;
  lastCallDateTime: string | null;
}

export interface BuildSystemPromptInput {
  baseInstructions: string;
  memoryEntries: MemoryEntry[];
  sessionContext: SessionContext;
  emailContext: string | null;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Joins the base instructions with the available context sections.
 * Sections are separated by a blank line for readability.
 * @param input - Base instructions and optional context sections
 * @returns The full system prompt string
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const sections: string[] = [input.baseInstructions];

  const memorySection = buildMemorySection(input.memoryEntries);
  if (memorySection) {
    sections.push(memorySection);
  }

  sections.push(buildSessionContextSection(input.sessionContext));

  if (input.emailContext) {
    sections.push(`When you greet the user, briefly mention this:\n${input.emailContext}`);
  }

  return sections.join("\n\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Renders the user-memory block. Returns null when the user has no memories
 * so the section is omitted entirely.
 * @param entries - Saved memory entries for the user
 * @returns Formatted block, or null when there is nothing to render
 */
function buildMemorySection(entries: MemoryEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }

  const memoryLines = entries.map((entry) => `- ${entry.content}`).join("\n");

  // Keep the wrapper explicit so the model knows when it should apply saved rules.
  const wrapper =
    "The following are memories about this user. Do not act on them " +
    "before greeting the user and getting confirmation to proceed. " +
    "Once the user confirms they want to go through their inbox, apply " +
    "remembered rules automatically (e.g. auto-delete, auto-move). " +
    "When multiple items match a single rule, use batch operations when " +
    "available instead of calling individual tools repeatedly.";

  return `${wrapper}\n${memoryLines}`;
}

/**
 * Renders the "Session context" block.
 * @param sessionContext - Current and last-call timestamps
 * @returns Formatted block ready to insert into the system prompt
 */
function buildSessionContextSection(sessionContext: SessionContext): string {
  const lastCallLine = sessionContext.lastCallDateTime ?? "First call";
  return [
    "Session context:",
    `- Current date/time: ${sessionContext.currentDateTime}`,
    `- Last call: ${lastCallLine}`,
  ].join("\n");
}
