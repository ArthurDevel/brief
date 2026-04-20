/**
 * Shared definitions for WhatsApp connector pages.
 *
 * Responsibilities:
 * - Keep supported connector metadata in one place
 * - Provide stable labels, routes, and user-facing copy
 * - Avoid repeating toolkit-specific strings across pages and routes
 */

// ============================================================================
// TYPES
// ============================================================================

export type WhatsAppConnectorToolkit = "gmail" | "notion";

export interface WhatsAppConnectorDefinition {
  toolkit: WhatsAppConnectorToolkit;
  label: string;
  routeSegment: string;
  navDescription: string;
  pageDescription: string;
  successMessage: string;
  authRequiredMessage: string;
  connectionFailedMessage: string;
  startFailedMessage: string;
  loadingLabel: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONNECTOR_DEFINITIONS: Record<
  WhatsAppConnectorToolkit,
  WhatsAppConnectorDefinition
> = {
  gmail: {
    toolkit: "gmail",
    label: "Gmail",
    routeSegment: "gmail",
    navDescription:
      "Start the WhatsApp-scoped Gmail auth flow that stores a user-specific Composio connection.",
    pageDescription:
      "This page keeps the WhatsApp sign-in flow inline, then starts the Composio Gmail connection in-browser.",
    successMessage:
      "Gmail is connected. Future WhatsApp requests will use your account.",
    authRequiredMessage:
      "Sign in with your WhatsApp number before you connect Gmail.",
    connectionFailedMessage:
      "Gmail was not connected. Please try again.",
    startFailedMessage:
      "We could not start the Gmail connection. Please try again.",
    loadingLabel: "Opening Gmail...",
  },
  notion: {
    toolkit: "notion",
    label: "Notion",
    routeSegment: "notion",
    navDescription:
      "Start the WhatsApp-scoped Notion auth flow that stores a user-specific Composio connection.",
    pageDescription:
      "This page keeps the WhatsApp sign-in flow inline, then starts the Composio Notion connection in-browser.",
    successMessage:
      "Notion is connected. Future WhatsApp requests can use your workspace.",
    authRequiredMessage:
      "Sign in with your WhatsApp number before you connect Notion.",
    connectionFailedMessage:
      "Notion was not connected. Please try again.",
    startFailedMessage:
      "We could not start the Notion connection. Please try again.",
    loadingLabel: "Opening Notion...",
  },
};

const CONNECTOR_TOOLKITS = Object.keys(
  CONNECTOR_DEFINITIONS
) as WhatsAppConnectorToolkit[];

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns one connector definition for a supported toolkit.
 * @param toolkit - Supported toolkit slug
 * @returns Shared connector definition
 */
export function getWhatsAppConnectorDefinition(
  toolkit: WhatsAppConnectorToolkit
): WhatsAppConnectorDefinition {
  return CONNECTOR_DEFINITIONS[toolkit];
}

/**
 * Lists every supported WhatsApp connector definition.
 * @returns All connector definitions in display order
 */
export function listWhatsAppConnectorDefinitions(): WhatsAppConnectorDefinition[] {
  return CONNECTOR_TOOLKITS.map((toolkit) => CONNECTOR_DEFINITIONS[toolkit]);
}

/**
 * Returns a readable label for a raw toolkit slug.
 * @param toolkit - Raw toolkit slug from a route or database row
 * @returns Human-readable toolkit label
 */
export function getWhatsAppConnectorLabel(toolkit: string): string {
  const definition = CONNECTOR_DEFINITIONS[toolkit as WhatsAppConnectorToolkit];
  if (definition) {
    return definition.label;
  }

  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}
