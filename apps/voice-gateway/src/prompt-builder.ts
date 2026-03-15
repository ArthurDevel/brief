/**
 * Builds the system prompt for the OpenAI Realtime API session.
 *
 * Assembles user-specific instructions from memory entries and tool
 * approval configuration. The prompt tells the AI how to behave, what
 * it knows about the user, and which tools require confirmation.
 *
 * Responsibilities:
 * - buildSystemPrompt: assemble base instructions + user memory + tool behavior
 */

import type { ToolApprovalConfig } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

const BASE_INSTRUCTIONS = `You are a helpful voice email assistant. The user is calling you on the phone to manage their email inbox.

IMPORTANT: Always respond in English, regardless of what language you think you hear. Never switch to another language.

You have access to tools to list, read, search, draft, delete, archive, and send emails. You can also save things to memory and submit feature requests. Use them whenever the user asks about their inbox or wants to take action.

Speak fast and be brief. Use short sentences. No filler words. Get to the point immediately. When listing emails, just say the sender and subject in quick succession. When reading an email, summarize the key points only.

Always confirm before destructive actions like deleting or sending emails.`;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Builds the full system prompt with user-specific context injected.
 * @param memoryEntries - User's persistent memory entries
 * @param toolApprovalConfig - User's per-tool approval overrides
 * @returns The assembled system prompt string
 */
export function buildSystemPrompt(
  memoryEntries: { id: string; content: string }[],
  toolApprovalConfig: ToolApprovalConfig
): string {
  const sections: string[] = [BASE_INSTRUCTIONS];

  // Add user memory section if there are entries
  if (memoryEntries.length > 0) {
    const memoryLines = memoryEntries.map((entry) => `- ${entry.content}`).join("\n");
    sections.push(`You remember the following about this user:\n${memoryLines}`);
  }

  // Add tool behavior section
  sections.push(buildToolBehaviorSection(toolApprovalConfig));

  return sections.join("\n\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the tool behavior section describing which tools auto-execute,
 * which require dashboard approval, and which are read-only.
 * @param config - User's per-tool approval overrides
 * @returns Tool behavior description string
 */
function buildToolBehaviorSection(config: ToolApprovalConfig): string {
  const readOnly: string[] = [];
  const autoExecute: string[] = [];
  const requiresApproval: string[] = [];

  // Categorize all tools based on effective classification
  const allTools: { name: string; defaultClass: string }[] = [
    { name: "list_inbox", defaultClass: "read_only" },
    { name: "read_email", defaultClass: "read_only" },
    { name: "search_emails", defaultClass: "read_only" },
    { name: "mark_as_read", defaultClass: "mutating_auto" },
    { name: "archive_email", defaultClass: "mutating_auto" },
    { name: "draft_email", defaultClass: "mutating_auto" },
    { name: "delete_email", defaultClass: "mutating_queued" },
    { name: "send_email", defaultClass: "mutating_queued" },
    { name: "save_memory", defaultClass: "read_only" },
    { name: "submit_feature_request", defaultClass: "read_only" },
  ];

  for (const tool of allTools) {
    // send_email is always queued regardless of config
    const effective = tool.name === "send_email" ? "mutating_queued" : (config[tool.name] ?? tool.defaultClass);

    switch (effective) {
      case "read_only":
        readOnly.push(tool.name);
        break;
      case "mutating_auto":
        autoExecute.push(tool.name);
        break;
      case "mutating_queued":
        requiresApproval.push(tool.name);
        break;
    }
  }

  const lines: string[] = ["Tool behavior:"];

  if (readOnly.length > 0) {
    lines.push(`- Read-only (instant, no side effects): ${readOnly.join(", ")}`);
  }
  if (autoExecute.length > 0) {
    lines.push(`- Auto-execute (runs immediately): ${autoExecute.join(", ")}`);
  }
  if (requiresApproval.length > 0) {
    lines.push(
      `- Requires dashboard approval (queued, tell the user to approve it from the dashboard): ${requiresApproval.join(", ")}`
    );
  }

  return lines.join("\n");
}
