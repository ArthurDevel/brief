/**
 * HTML template for the end-of-session summary email.
 *
 * Renders actions taken during a voice call session, split into two sections
 * (pending and completed) matching the dashboard layout. Shows tool label,
 * From/To, Subject columns, and action buttons for pending items.
 *
 * Responsibilities:
 * - Split actions into pending and completed sections
 * - Show From/To and Subject as separate columns (like the dashboard)
 * - Render approve/decline buttons for pending actions
 * - Render bulk approve all / decline all buttons
 * - Render the full HTML email body
 */

import type { ActionRow } from "@dublin/tools";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";

// ============================================================================
// CONSTANTS
// ============================================================================

const BUTTON_STYLE_APPROVE =
  "display: inline-block; padding: 6px 14px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600;";

const BUTTON_STYLE_DECLINE =
  "display: inline-block; padding: 6px 14px; background-color: #dc2626; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: 600;";

const CELL_STYLE = "padding: 8px 12px; border-bottom: 1px solid #eee;";

const HEADER_STYLE = "padding: 8px 12px; text-align: left;";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Builds the full HTML body for a session summary email.
 * @param actions - List of actions taken during the session (already filtered, no read-only)
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

  const pendingActions = actions.filter((a) => a.status === "pending");
  const completedActions = actions.filter((a) => a.status !== "pending");

  // Bulk buttons only shown when there are pending actions
  const bulkButtons =
    pendingActions.length > 0
      ? `<div style="margin-bottom: 16px;">
          <a href="${sessionUrl}?action=approve&actionId=all" style="${BUTTON_STYLE_APPROVE} margin-right: 8px;">Approve All</a>
          <a href="${sessionUrl}?action=reject&actionId=all" style="${BUTTON_STYLE_DECLINE}">Decline All</a>
        </div>`
      : "";

  const pendingSection =
    pendingActions.length > 0
      ? `<h3 style="margin: 0 0 8px 0;">Pending Actions (${pendingActions.length})</h3>
         ${bulkButtons}
         ${buildActionTable(pendingActions, sessionUrl, true)}`
      : "";

  const completedSection =
    completedActions.length > 0
      ? `<h3 style="margin: 24px 0 8px 0;">Completed Actions (${completedActions.length})</h3>
         ${buildActionTable(completedActions, sessionUrl, false)}`
      : "";

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Session Summary</h2>
      <p>
        ${actions.length} action${actions.length === 1 ? "" : "s"} during this session.
        <a href="${sessionUrl}" style="color: #2563eb; margin-left: 8px; font-size: 13px;">View on dashboard</a>
      </p>
      ${pendingSection}
      ${completedSection}
    </div>`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds an HTML table for a list of actions.
 * @param actions - Actions to render
 * @param sessionUrl - Base session dashboard URL
 * @param showButtons - Whether to show approve/decline buttons (for pending) or status text
 * @returns HTML table string
 */
function buildActionTable(
  actions: ActionRow[],
  sessionUrl: string,
  showButtons: boolean
): string {
  const rows = actions
    .map((action) => {
      const label = TOOL_LABELS[action.toolName] ?? action.toolName;
      const lastCol = showButtons
        ? buildActionButtons(sessionUrl, action.id)
        : action.status;

      return `
        <tr>
          <td style="${CELL_STYLE}">${label}</td>
          <td style="${CELL_STYLE}">${getContact(action.arguments)}</td>
          <td style="${CELL_STYLE}">${getSubject(action.arguments)}</td>
          <td style="${CELL_STYLE}">${lastCol}</td>
        </tr>`;
    })
    .join("");

  const lastHeader = showButtons ? "" : "Status";

  return `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #f5f5f5;">
          <th style="${HEADER_STYLE}">Action</th>
          <th style="${HEADER_STYLE}">From / To</th>
          <th style="${HEADER_STYLE}">Subject</th>
          <th style="${HEADER_STYLE}">${lastHeader}</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

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
 * Extracts the "from" or "to" field from action arguments.
 * @param args - The action arguments object
 * @returns The from/to string or "-"
 */
function getContact(args: Record<string, unknown>): string {
  const value = (args.from ?? args.to) as string | undefined;
  return value ?? "-";
}

/**
 * Extracts the subject field from action arguments.
 * @param args - The action arguments object
 * @returns The subject string or "-"
 */
function getSubject(args: Record<string, unknown>): string {
  const value = args.subject as string | undefined;
  return value ?? "-";
}
