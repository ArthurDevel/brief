/**
 * Shared view and callback logic for the WhatsApp Gmail connector page.
 *
 * Responsibilities:
 * - Map URL query parameters to safe UI notices
 * - Parse Composio callback query parameters
 * - Keep redirect query codes stable for the page and callback route
 */

// ============================================================================
// TYPES
// ============================================================================

export type GmailConnectorNoticeKind = "success" | "error";

export interface GmailConnectorNotice {
  kind: GmailConnectorNoticeKind;
  message: string;
}

export interface GmailConnectCallbackResult {
  connectedAccountId: string | null;
  errorCode: GmailConnectorErrorCode | null;
  status: "success" | "failed" | null;
}

export type GmailConnectorErrorCode =
  | "auth_required"
  | "callback_invalid"
  | "connection_failed"
  | "save_failed";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Converts page query params into a safe UI notice.
 * @param input - Query state for the page
 * @returns Notice to render, or null when there is nothing to show
 */
export function getGmailConnectorNotice(input: {
  connected?: string;
  error?: string;
}): GmailConnectorNotice | null {
  if (input.connected === "1") {
    return {
      kind: "success",
      message: "Gmail is connected. Future WhatsApp requests will use your account.",
    };
  }

  const errorCode = normalizeGmailConnectorErrorCode(input.error);
  if (!errorCode) {
    return null;
  }

  return {
    kind: "error",
    message: getGmailConnectorErrorMessage(errorCode),
  };
}

/**
 * Parses callback query params from Composio.
 * @param searchParams - URL search params from the callback request
 * @returns Parsed callback state with validated status and account ID
 */
export function parseGmailConnectCallback(
  searchParams: URLSearchParams
): GmailConnectCallbackResult {
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
 * Returns the safe message for a connector error code.
 * @param code - Stable error code used in redirects or API responses
 * @returns Safe human-readable message
 */
export function getGmailConnectorErrorMessage(
  code: GmailConnectorErrorCode
): string {
  switch (code) {
    case "auth_required":
      return "Sign in with your WhatsApp number before you connect Gmail.";
    case "callback_invalid":
      return "The Gmail connection did not return the expected details. Please try again.";
    case "connection_failed":
      return "Gmail was not connected. Please try again.";
    case "save_failed":
      return "Gmail finished connecting, but we could not save the result. Please try again.";
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates a raw error code from the query string.
 * @param value - Raw error code from search params
 * @returns Stable error code, or null when unknown
 */
function normalizeGmailConnectorErrorCode(
  value: string | undefined
): GmailConnectorErrorCode | null {
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
