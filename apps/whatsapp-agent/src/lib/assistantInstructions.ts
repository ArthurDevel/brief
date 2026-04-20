/**
 * Builds voice-agent instructions from the static prompt and caller-specific connection state.
 *
 * Responsibilities:
 * - Tell the agent which toolkits are already connected for this caller
 * - Explain when to use the WhatsApp auth custom tools
 * - Keep connection-aware prompting out of the entrypoint file
 */

import type { WhatsAppCallerContext } from "./whatsappRuntime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CONNECTOR_TOOLKIT_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  notion: "Notion",
  outlook: "Outlook",
};

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Appends connection-aware guidance to the base voice-agent instructions.
 * @param baseInstructions - Static instructions from the environment
 * @param callerContext - Caller identity and connection state
 * @returns Final instructions for the active caller
 */
export function buildAssistantInstructions(
  baseInstructions: string,
  callerContext: WhatsAppCallerContext
): string {
  const connectedToolkitSlugs = Object.keys(callerContext.connectedAccountsByToolkit);
  const connectedToolkitLabels = connectedToolkitSlugs.map(getToolkitLabel);
  const connectionSummary = connectedToolkitLabels.length > 0
    ? `Connected apps for this caller: ${connectedToolkitLabels.join(", ")}.`
    : "This caller does not have any active connected apps yet.";

  const guidanceLines = [
    baseInstructions.trim(),
    connectionSummary,
    "For external app tasks, follow the Composio session flow: use COMPOSIO_SEARCH_TOOLS to find the right app tools, then use COMPOSIO_MULTI_EXECUTE_TOOL to run the chosen tool.",
    "When search shows that an app is not connected, use the WhatsApp auth tools below for Gmail, Google Calendar, Notion, or Outlook.",
    "If the caller asks to connect Gmail, Google Calendar, Notion, or Outlook, use LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE with the matching toolkit.",
    "If the caller wants to review or reconnect apps, use LOCAL_SEND_WHATSAPP_CONNECTOR_OVERVIEW.",
    "If a requested app is not connected, do not pretend you can access it. Send the WhatsApp auth template first, then tell the caller to open it.",
  ];

  if (callerContext.connectionGuidanceMessage) {
    guidanceLines.push(callerContext.connectionGuidanceMessage);
  }

  return guidanceLines.join("\n\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns a readable label for one toolkit slug.
 * @param toolkit - Raw toolkit slug
 * @returns Human-readable label
 */
function getToolkitLabel(toolkit: string): string {
  return CONNECTOR_TOOLKIT_LABELS[toolkit] ?? toolkit;
}
