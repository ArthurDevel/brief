/**
 * HTML template for the end-of-session summary email.
 *
 * Renders a table of actions taken during a voice call session,
 * showing the tool name, a short description, status, and action buttons.
 * Pending actions get Approve/Decline buttons that link to the session
 * dashboard with query params to trigger the action.
 *
 * Responsibilities:
 * - Map ToolName values to human-readable labels
 * - Build a short description from action arguments
 * - Render approve/decline buttons for pending actions
 * - Render bulk approve all / decline all buttons
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
  batch_archive_emails: "Batch Archive Emails",
  batch_delete_emails: "Batch Delete Emails",
};

/** Argument keys to prioritize when building action descriptions. */
const RELEVANT_KEYS = ["to", "from", "subject", "query", "content"];

const MAX_VALUE_LENGTH = 60;

const BUTTON_STYLE_APPROVE =
  "display: inline-block; padding: 6px 14px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600;";

const BUTTON_STYLE_DECLINE =
  "display: inline-block; padding: 6px 14px; background-color: #dc2626; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600;";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Builds the full HTML body for a session summary email.
 * @param actions - List of actions taken during the session
 * @param sessionId - The session ID, used for building dashboard links
 * @param baseUrl - The app base URL (e.g. https://app.example.com)
 * @returns HTML string ready to send
 */
export function buildSessionSummaryHtml(
  actions: ActionRow[],
  sessionId: string,
  baseUrl: string
): string {
  const sessionUrl = `${baseUrl}/dashboard/sessions/${sessionId}`;
  const hasPending = actions.some((a) => a.status === "pending");

  const rows = actions
    .map((action) => {
      const label = TOOL_NAME_LABELS[action.toolName] ?? action.toolName;
      const description = buildActionDescription(action);
      const buttons =
        action.status === "pending"
          ? buildActionButtons(sessionUrl, action.id)
          : action.status;
      return `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${label}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${description}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${action.status}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${buttons}</td>
        </tr>`;
    })
    .join("");

  // Bulk buttons only shown when there are pending actions
  const bulkButtons = hasPending
    ? `<div style="margin-bottom: 16px;">
        <a href="${sessionUrl}?action=approve&actionId=all" style="${BUTTON_STYLE_APPROVE} margin-right: 8px;">Approve All</a>
        <a href="${sessionUrl}?action=reject&actionId=all" style="${BUTTON_STYLE_DECLINE}">Decline All</a>
      </div>`
    : "";

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Session Summary</h2>
      <p>${actions.length} action${actions.length === 1 ? "" : "s"} taken during this session.</p>
      ${bulkButtons}
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f5f5f5;">
            <th style="padding: 8px 12px; text-align: left;">Action</th>
            <th style="padding: 8px 12px; text-align: left;">Details</th>
            <th style="padding: 8px 12px; text-align: left;">Status</th>
            <th style="padding: 8px 12px; text-align: left;"></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p style="margin-top: 16px; font-size: 13px;">
        <a href="${sessionUrl}" style="color: #2563eb;">View full session on dashboard</a>
      </p>
    </div>`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds approve/decline button HTML for a pending action.
 * @param sessionUrl - The base session dashboard URL
 * @param actionId - The action ID
 * @returns HTML string with two buttons
 */
function buildActionButtons(sessionUrl: string, actionId: string): string {
  const approveUrl = `${sessionUrl}?action=approve&actionId=${actionId}`;
  const declineUrl = `${sessionUrl}?action=reject&actionId=${actionId}`;
  return `<a href="${approveUrl}" style="${BUTTON_STYLE_APPROVE} margin-right: 6px;">Approve</a><a href="${declineUrl}" style="${BUTTON_STYLE_DECLINE}">Decline</a>`;
}

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
