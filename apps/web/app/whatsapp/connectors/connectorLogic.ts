/**
 * Shared view and callback logic for WhatsApp Composio connectors.
 *
 * Responsibilities:
 * - Map query parameters to safe UI notices
 * - Parse Composio callback query parameters
 * - Map stable API error codes to safe user-facing copy
 */

import type { WhatsAppConnectorDefinition } from "./connectorDefinitions";

// ============================================================================
// TYPES
// ============================================================================

export type ConnectorNoticeKind = "success" | "error";

export interface ConnectorNotice {
  kind: ConnectorNoticeKind;
  message: string;
}

export interface ConnectorCallbackResult {
  connectedAccountId: string | null;
  errorCode: ConnectorPageErrorCode | null;
  status: "success" | "failed" | null;
}

export type ConnectorPageErrorCode =
  | "auth_required"
  | "callback_invalid"
  | "connection_failed"
  | "save_failed";

export type ConnectorStartErrorCode =
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "CONNECTOR_START_FAILED";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Converts page query params into a safe UI notice.
 * @param definition - Shared connector copy
 * @param input - Query state for the page
 * @returns Notice to render, or null when there is nothing to show
 */
export function getConnectorNotice(
  definition: WhatsAppConnectorDefinition,
  input: {
    connected?: string;
    error?: string;
  }
): ConnectorNotice | null {
  if (input.connected === "1") {
    return {
      kind: "success",
      message: definition.successMessage,
    };
  }

  const errorCode = normalizeConnectorPageErrorCode(input.error);
  if (!errorCode) {
    return null;
  }

  return {
    kind: "error",
    message: getConnectorErrorMessage(definition, errorCode),
  };
}

/**
 * Parses callback query params from Composio.
 * @param searchParams - URL search params from the callback request
 * @returns Parsed callback state with validated status and account ID
 */
export function parseConnectorCallback(
  searchParams: URLSearchParams
): ConnectorCallbackResult {
  const rawStatus = searchParams.get("status");
  const status =
    rawStatus === "success" || rawStatus === "failed"
      ? rawStatus
      : null;
  const connectedAccountId = searchParams.get("connected_account_id");

  if (!status) {
    return {
      status: null,
      connectedAccountId: null,
      errorCode: "callback_invalid",
    };
  }

  if (status === "success" && !connectedAccountId) {
    return {
      status,
      connectedAccountId: null,
      errorCode: "callback_invalid",
    };
  }

  if (status === "failed") {
    return {
      status,
      connectedAccountId: connectedAccountId ?? null,
      errorCode: "connection_failed",
    };
  }

  return {
    status,
    connectedAccountId: connectedAccountId ?? null,
    errorCode: null,
  };
}

/**
 * Returns the safe message for a connector page error code.
 * @param definition - Shared connector copy
 * @param code - Stable error code used in redirects
 * @returns Safe human-readable message
 */
export function getConnectorErrorMessage(
  definition: WhatsAppConnectorDefinition,
  code: ConnectorPageErrorCode
): string {
  switch (code) {
    case "auth_required":
      return definition.authRequiredMessage;
    case "callback_invalid":
      return `The ${definition.label} connection did not return the expected details. Please try again.`;
    case "connection_failed":
      return definition.connectionFailedMessage;
    case "save_failed":
      return `${definition.label} finished connecting, but we could not save the result. Please try again.`;
  }
}

/**
 * Returns the safe message for a connector start API error code.
 * @param definition - Shared connector copy
 * @param code - Stable error code returned by the start route
 * @returns Safe human-readable message
 */
export function getConnectorStartErrorMessage(
  definition: WhatsAppConnectorDefinition,
  code: string | undefined
): string {
  const normalizedCode = normalizeConnectorStartErrorCode(code);

  switch (normalizedCode) {
    case "UNAUTHORIZED":
      return definition.authRequiredMessage;
    case "RATE_LIMITED":
      return "Too many attempts. Please wait a moment and try again.";
    case "CONNECTOR_START_FAILED":
      return definition.startFailedMessage;
    default:
      return "Something went wrong. Please try again.";
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates a raw page error code from the query string.
 * @param value - Raw error code from search params
 * @returns Stable page error code, or null when unknown
 */
function normalizeConnectorPageErrorCode(
  value: string | undefined
): ConnectorPageErrorCode | null {
  if (
    value === "auth_required" ||
    value === "callback_invalid" ||
    value === "connection_failed" ||
    value === "save_failed"
  ) {
    return value;
  }

  return null;
}

/**
 * Validates a raw start-route error code.
 * @param value - Raw error code from the API response
 * @returns Stable start error code, or null when unknown
 */
function normalizeConnectorStartErrorCode(
  value: string | undefined
): ConnectorStartErrorCode | null {
  if (
    value === "UNAUTHORIZED" ||
    value === "RATE_LIMITED" ||
    value === "CONNECTOR_START_FAILED"
  ) {
    return value;
  }

  return null;
}
