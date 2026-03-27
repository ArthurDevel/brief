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

const FONT_FAMILY =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

const BUTTON_STYLE_APPROVE =
  `display:block; padding:6px 14px; background-color:#16a34a; color:#ffffff; text-decoration:none; font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; text-align:center;`;

const BUTTON_STYLE_DECLINE =
  `display:block; padding:6px 14px; background-color:#dc2626; color:#ffffff; text-decoration:none; font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; text-align:center;`;

const BUTTON_STYLE_PRIMARY =
  `display:inline-block; padding:12px 28px; background-color:#000000; color:#ffffff; text-decoration:none; font-family:${FONT_FAMILY}; font-size:15px; font-weight:600;`;

const CELL_STYLE =
  `padding:10px 12px; border-bottom:1px solid #f4f4f5; font-family:${FONT_FAMILY}; font-size:13px; font-weight:500; color:#52525b;`;

const HEADER_STYLE =
  `padding:10px 12px; text-align:left; font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; color:#71717a; text-transform:uppercase; letter-spacing:0.05em;`;

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
      ? `<tr>
          <td style="padding:0 40px 24px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding-right:8px;">
                <a href="${sessionUrl}?action=approve&actionId=all" style="${BUTTON_STYLE_APPROVE}">Approve All</a>
              </td>
              <td>
                <a href="${sessionUrl}?action=reject&actionId=all" style="${BUTTON_STYLE_DECLINE}">Decline All</a>
              </td>
            </tr></table>
          </td>
        </tr>`
      : "";

  const pendingSection =
    pendingActions.length > 0
      ? `<tr>
          <td style="padding:0 40px 8px 40px;">
            <p style="margin:0; font-family:${FONT_FAMILY}; font-size:16px; font-weight:700; color:#000000; letter-spacing:-0.02em;">
              Pending Actions (${pendingActions.length})
            </p>
          </td>
        </tr>
        ${bulkButtons}
        <tr>
          <td style="padding:0 40px 32px 40px;">
            ${buildActionTable(pendingActions, sessionUrl, true)}
          </td>
        </tr>`
      : "";

  const completedSection =
    completedActions.length > 0
      ? `<tr>
          <td style="padding:0 40px 8px 40px;">
            <p style="margin:0; font-family:${FONT_FAMILY}; font-size:16px; font-weight:700; color:#000000; letter-spacing:-0.02em;">
              Completed Actions (${completedActions.length})
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px 40px;">
            ${buildActionTable(completedActions, sessionUrl, false)}
          </td>
        </tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Session Summary</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

  <!-- Preheader -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    ${actions.length} action${actions.length === 1 ? "" : "s"} from your session — review pending items.
  </div>

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Email container -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e4e4e7;">

          <!-- Logo -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:28px; height:28px; background-color:#000000; text-align:center; vertical-align:middle; font-family:Georgia,Times,'Times New Roman',serif; font-size:16px; color:#ffffff; line-height:28px;">
                    B
                  </td>
                  <td style="padding-left:8px; font-family:${FONT_FAMILY}; font-size:16px; font-weight:700; color:#000000; letter-spacing:-0.02em;">
                    BrewDock
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <h1 style="margin:0 0 16px 0; font-family:${FONT_FAMILY}; font-size:24px; font-weight:800; color:#000000; letter-spacing:-0.03em; line-height:1.2;">
                Session Summary
              </h1>
              <p style="margin:0 0 24px 0; font-family:${FONT_FAMILY}; font-size:15px; font-weight:500; color:#52525b; line-height:1.5;">
                ${actions.length} action${actions.length === 1 ? "" : "s"} during this session.
              </p>
            </td>
          </tr>

          <!-- View on dashboard button -->
          <tr>
            <td style="padding:0 40px 32px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#000000;">
                    <a href="${sessionUrl}" target="_blank" style="${BUTTON_STYLE_PRIMARY}">
                      View on dashboard &#8594;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="border-top:1px solid #e4e4e7;"></div>
            </td>
          </tr>

          <!-- Spacer -->
          <tr><td style="padding:16px 0 0 0;"></td></tr>

          <!-- Pending actions -->
          ${pendingSection}

          <!-- Completed actions -->
          ${completedSection}

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px; background-color:#fafafa; border-top:1px solid #e4e4e7;">
              <p style="margin:0 0 4px 0; font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; color:#71717a;">
                BrewDock
              </p>
              <p style="margin:0 0 12px 0; font-family:${FONT_FAMILY}; font-size:12px; font-weight:500; color:#a1a1aa;">
                Do your email while you drive.
              </p>
              <p style="margin:0; font-family:${FONT_FAMILY}; font-size:11px; font-weight:400; color:#a1a1aa; line-height:1.5;">
                BrewDock Inc., 123 Main Street, Suite 100, San Francisco, CA 94105
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
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
        : `<span style="font-family:${FONT_FAMILY}; font-size:12px; font-weight:600; color:#71717a; text-transform:uppercase; letter-spacing:0.05em;">${action.status}</span>`;

      return `
        <tr>
          <td style="${CELL_STYLE} color:#000000; font-weight:600;">${label}</td>
          <td style="${CELL_STYLE}">${getContact(action.arguments)}</td>
          <td style="${CELL_STYLE}">${getSubject(action.arguments)}</td>
          <td style="${CELL_STYLE}">${lastCol}</td>
        </tr>`;
    })
    .join("");

  const lastHeader = showButtons ? "" : "Status";

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4e4e7;">
      <thead>
        <tr style="background-color:#fafafa; border-bottom:1px solid #e4e4e7;">
          <th style="${HEADER_STYLE} width:14%;">Action</th>
          <th style="${HEADER_STYLE} width:24%;">From / To</th>
          <th style="${HEADER_STYLE} width:48%;">Subject</th>
          <th style="${HEADER_STYLE} width:14%;">${lastHeader}</th>
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td><a href="${approveUrl}" style="${BUTTON_STYLE_APPROVE}">Approve</a></td></tr><tr><td style="padding-top:4px;"><a href="${declineUrl}" style="${BUTTON_STYLE_DECLINE}">Decline</a></td></tr></table>`;
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
