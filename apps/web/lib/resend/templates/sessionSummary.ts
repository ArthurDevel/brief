/**
 * HTML template for the end-of-session summary email.
 *
 * Renders a table of actions taken during a voice call session,
 * showing the tool name, a short description, and the status.
 *
 * Responsibilities:
 * - Map ToolName values to human-readable labels
 * - Build a short description from action arguments
 * - Render the full HTML email body
 */

import type { ActionRow, ToolName } from "@dublin/tools";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Human-readable labels for each tool name. */
const TOOL_NAME_LABELS: Record<ToolName, string> = {
  list_inbox: "List Inbox",
  read_email: "Read Email",
  read_thread: "Read Thread",
  search_emails: "Search Emails",
  mark_as_read: "Mark as Read",
  draft_email: "Draft Email",
  delete_email: "Delete Email",
  archive_email: "Archive Email",
  send_email: "Send Email",
  save_memory: "Save Memory",
  submit_feature_request: "Submit Feature Request",
};

/** Argument keys to prioritize when building action descriptions. */
const RELEVANT_KEYS = ["to", "subject", "query", "message_id", "content"];

const MAX_VALUE_LENGTH = 60;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Builds the full HTML body for a session summary email.
 * @param actions - List of actions taken during the session
 * @returns HTML string ready to send
 */
export function buildSessionSummaryHtml(actions: ActionRow[]): string {
  const rows = actions
    .map((action) => {
      const label = TOOL_NAME_LABELS[action.toolName] ?? action.toolName;
      const description = buildActionDescription(action);
      return `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${label}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${description}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${action.status}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Session Summary</h2>
      <p>${actions.length} action${actions.length === 1 ? "" : "s"} taken during this session.</p>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f5f5f5;">
            <th style="padding: 8px 12px; text-align: left;">Action</th>
            <th style="padding: 8px 12px; text-align: left;">Details</th>
            <th style="padding: 8px 12px; text-align: left;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds a short human-readable description from the action's arguments.
 * Picks the most relevant fields (to, subject, query, etc.) and truncates long values.
 * @param action - The action row
 * @returns A short description string
 */
function buildActionDescription(action: ActionRow): string {
  const args = action.arguments;
  if (!args || Object.keys(args).length === 0) return "-";

  // Pick the most relevant fields for common tools
  const parts: string[] = [];

  for (const key of RELEVANT_KEYS) {
    if (key in args) {
      const value = String(args[key]);
      const truncated =
        value.length > MAX_VALUE_LENGTH
          ? value.slice(0, MAX_VALUE_LENGTH - 3) + "..."
          : value;
      parts.push(`${key}: ${truncated}`);
    }
  }

  if (parts.length === 0) {
    // Fall back to first two keys
    const entries = Object.entries(args).slice(0, 2);
    for (const [key, value] of entries) {
      const str = String(value);
      const truncated =
        str.length > MAX_VALUE_LENGTH
          ? str.slice(0, MAX_VALUE_LENGTH - 3) + "..."
          : str;
      parts.push(`${key}: ${truncated}`);
    }
  }

  return parts.join(", ");
}
