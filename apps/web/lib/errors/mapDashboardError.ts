import {
  DASHBOARD_ERROR_MESSAGES,
  DEFAULT_USER_ERROR,
  getDashboardErrorMessage,
  isDashboardErrorCode,
  type DashboardErrorCode,
} from "./dashboardErrors";

export type DashboardErrorContext =
  | "email"
  | "call"
  | "call-trigger"
  | "action-approve"
  | "action-reject"
  | "action-undo"
  | "action-draft"
  | "action-bulk"
  | "actions-page"
  | "dashboard-overview"
  | "session"
  | "settings-general"
  | "settings-email"
  | "settings-schedule"
  | "settings-billing"
  | "settings-feature-requests";

interface DashboardErrorRecord extends Record<string, unknown> {
  code?: unknown;
  error?: unknown;
  message?: unknown;
  name?: unknown;
  result?: unknown;
}

interface DashboardErrorDetails {
  code: DashboardErrorCode;
  message: string;
}

const CONTEXT_DEFAULT_CODES: Record<DashboardErrorContext, DashboardErrorCode> = {
  email: "EMAIL_CONNECT_FAILED",
  call: "CALL_START_FAILED",
  "call-trigger": "CALL_TRIGGER_FAILED",
  "action-approve": "ACTION_APPROVE_FAILED",
  "action-reject": "ACTION_REJECT_FAILED",
  "action-undo": "ACTION_UNDO_FAILED",
  "action-draft": "ACTION_DRAFT_FAILED",
  "action-bulk": "BULK_ACTION_FAILED",
  "actions-page": "ACTION_LOAD_FAILED",
  "dashboard-overview": "ACTION_LOAD_FAILED",
  session: "SESSION_LOAD_FAILED",
  "settings-general": "SETTINGS_SAVE_FAILED",
  "settings-email": "EMAIL_SAVE_FAILED",
  "settings-schedule": "SCHEDULE_SAVE_FAILED",
  "settings-billing": "BILLING_LOAD_FAILED",
  "settings-feature-requests": "FEATURE_REQUEST_SUBMIT_FAILED",
};

const CODE_ALIASES: Record<string, DashboardErrorCode> = {
  unauthorized: "UNAUTHORIZED",
  unauthenticated: "UNAUTHORIZED",
  no_phone_configured: "PHONE_REQUIRED",
  country_not_supported: "COUNTRY_NOT_SUPPORTED",
  usage_limit_exceeded: "USAGE_LIMIT_REACHED",
  limit_reached: "USAGE_LIMIT_REACHED",
  mic_permission_denied: "MIC_PERMISSION_DENIED",
};

function isRecord(value: unknown): value is DashboardErrorRecord {
  return typeof value === "object" && value !== null;
}

function normalizeDashboardErrorCode(value: string | null | undefined): DashboardErrorCode | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isDashboardErrorCode(trimmed)) return trimmed;

  const upper = trimmed.toUpperCase();
  if (isDashboardErrorCode(upper)) return upper;

  const lower = trimmed.toLowerCase();
  return CODE_ALIASES[trimmed] ?? CODE_ALIASES[upper] ?? CODE_ALIASES[lower] ?? null;
}

export function extractErrorCode(input: unknown): string | null {
  if (typeof input === "string") {
    return normalizeDashboardErrorCode(input);
  }

  if (input instanceof Error) {
    const fromCode = normalizeDashboardErrorCode(
      typeof (input as Error & { code?: unknown }).code === "string"
        ? String((input as Error & { code?: unknown }).code)
        : null
    );
    if (fromCode) return fromCode;
    return normalizeDashboardErrorCode(input.message);
  }

  if (!isRecord(input)) return null;

  const candidates = [
    input.code,
    input.errorCode,
    input.error_code,
    input.message,
    input.error,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = normalizeDashboardErrorCode(candidate);
      if (normalized) return normalized;
    }
  }

  if (isRecord(input.result) && typeof input.result.error === "string") {
    return normalizeDashboardErrorCode(input.result.error);
  }

  return null;
}

export function extractErrorMessage(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof Error) return input.message;
  if (!isRecord(input)) return null;

  if (typeof input.error === "string") return input.error;
  if (typeof input.message === "string") return input.message;

  if (isRecord(input.result) && typeof input.result.error === "string") {
    return input.result.error;
  }

  return null;
}

function getErrorName(input: unknown): string {
  if (input instanceof Error && input.name) return input.name;
  if (isRecord(input) && typeof input.name === "string") return input.name;
  return "";
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function inferCodeFromMessage(
  input: unknown,
  context: DashboardErrorContext,
  fallbackCode?: DashboardErrorCode
): DashboardErrorCode {
  const explicitCode = normalizeDashboardErrorCode(extractErrorCode(input));
  if (explicitCode) return explicitCode;

  const message = extractErrorMessage(input) ?? "";
  const errorName = getErrorName(input).toLowerCase();
  const haystack = `${message} ${errorName}`.toLowerCase();

  if (
    includesAny(haystack, [
      "unauthorized",
      "not authenticated",
      "sign in first",
      "session expired",
      "unauthenticated",
    ])
  ) {
    return "UNAUTHORIZED";
  }

  if (includesAny(haystack, ["failed to fetch", "networkerror", "network request failed"])) {
    return "NETWORK_ERROR";
  }

  if (haystack.includes("reconnect_required")) {
    return "EMAIL_RECONNECT_REQUIRED";
  }

  if (
    includesAny(haystack, [
      "no active email account configured",
      "no email account configured",
      "connect your email account",
    ])
  ) {
    return "EMAIL_ACCOUNT_REQUIRED";
  }

  if (
    includesAny(haystack, [
      "missing stored passwords",
      "both imap and smtp passwords",
      "passwords for both imap and smtp",
    ])
  ) {
    return "EMAIL_PASSWORDS_REQUIRED";
  }

  if (includesAny(haystack, ["createhostedauthlink", "failed to initiate connection", "invalid provider"])) {
    return "EMAIL_CONNECT_FAILED";
  }

  if (
    includesAny(haystack, [
      "getaccount failed",
      "failed to load active email account",
      "failed to load email account",
      "imap connection failed",
    ])
  ) {
    return chooseEmailFailureCode(context, fallbackCode, "EMAIL_INBOX_CONNECT_FAILED");
  }

  if (
    includesAny(haystack, [
      "auth",
      "login failed",
      "invalid credentials",
      "econnrefused",
      "enotfound",
      "etimedout",
      "socket closed",
      "imap",
    ])
  ) {
    return chooseEmailFailureCode(context, fallbackCode, "EMAIL_INBOX_CONNECT_FAILED");
  }

  if (
    includesAny(haystack, [
      "smtp",
      "mail from",
      "greeting never received",
      "greeting timeout",
      "eauth",
      "send failed",
      "could not send",
    ])
  ) {
    return chooseEmailFailureCode(context, fallbackCode, "EMAIL_SMTP_CONNECT_FAILED");
  }

  if (includesAny(haystack, ["limit_reached", "usage_limit_exceeded", "monthly call limit"])) {
    return "USAGE_LIMIT_REACHED";
  }

  if (includesAny(haystack, ["no_phone_configured", "no phone number configured", "no phone configured"])) {
    return "PHONE_REQUIRED";
  }

  if (includesAny(haystack, ["country_not_supported", "country is not yet supported"])) {
    return "COUNTRY_NOT_SUPPORTED";
  }

  if (
    includesAny(haystack, [
      "notallowederror",
      "permission denied",
      "microphone access denied",
      "could not start audio source",
      "no audio track found",
      "notfounderror",
    ])
  ) {
    return "MIC_PERMISSION_DENIED";
  }

  if (
    includesAny(haystack, [
      "failed to send sdp offer",
      "ice",
      "webrtc",
      "transport",
      "sdp",
      "connection failed",
    ])
  ) {
    return "CALL_CONNECT_FAILED";
  }

  if (haystack.includes("action not found")) {
    return "ACTION_NOT_FOUND";
  }

  if (
    includesAny(haystack, [
      "action is not pending",
      "action is not executed",
      "already been handled",
      "cannot be executed -- status is",
      "cannot be undone -- status is",
    ])
  ) {
    return "ACTION_ALREADY_HANDLED";
  }

  if (haystack.includes("folder") && includesAny(haystack, ["does not exist", "not found"])) {
    return "ACTION_FOLDER_MISSING";
  }

  if (
    includesAny(haystack, [
      "email with uid",
      "no email found with message-id",
      "message-id header not found",
      "email not found",
    ])
  ) {
    return "ACTION_EMAIL_MISSING";
  }

  if (
    includesAny(haystack, [
      "phone number belongs to",
      "doesn't match the selected country",
      "does not match the selected country",
    ])
  ) {
    return "PHONE_COUNTRY_MISMATCH";
  }

  if (
    includesAny(haystack, [
      "international format",
      "invalid phone number format",
      "number is required",
      "countrycode is required",
    ])
  ) {
    return "PHONE_INVALID";
  }

  if (includesAny(haystack, ["description is required", "enter a feature request"])) {
    return "FEATURE_REQUEST_EMPTY";
  }

  if (fallbackCode) return fallbackCode;
  return CONTEXT_DEFAULT_CODES[context] ?? "UNKNOWN_ERROR";
}

function chooseEmailFailureCode(
  context: DashboardErrorContext,
  fallbackCode: DashboardErrorCode | undefined,
  defaultCode: DashboardErrorCode
): DashboardErrorCode {
  if (fallbackCode === "EMAIL_INBOX_VERIFY_FAILED" || fallbackCode === "EMAIL_SMTP_VERIFY_FAILED") {
    return fallbackCode;
  }
  if (context === "action-approve" || context === "action-undo" || context === "action-draft") {
    return "ACTION_EXECUTION_FAILED";
  }
  return defaultCode;
}

export function mapDashboardErrorDetails(
  input: unknown,
  context: DashboardErrorContext,
  fallbackCode?: DashboardErrorCode
): DashboardErrorDetails {
  const code = inferCodeFromMessage(input, context, fallbackCode);
  return {
    code,
    message: DASHBOARD_ERROR_MESSAGES[code] ?? DEFAULT_USER_ERROR,
  };
}

export function mapDashboardError(
  input: unknown,
  context: DashboardErrorContext,
  fallbackCode?: DashboardErrorCode
): string {
  return mapDashboardErrorDetails(input, context, fallbackCode).message;
}

export function logAndMapDashboardError(
  input: unknown,
  context: DashboardErrorContext,
  fallbackCode?: DashboardErrorCode
): string {
  const details = mapDashboardErrorDetails(input, context, fallbackCode);

  if (process.env.NODE_ENV !== "production") {
    console.warn("[dashboard-error]", {
      context,
      code: details.code,
      message: details.message,
      error: input,
    });
  }

  return details.message;
}

export async function buildDashboardErrorFromResponse(
  response: Response,
  fallback?: { code?: DashboardErrorCode; error?: string }
): Promise<{ code?: string; error?: string; status: number; statusText: string }> {
  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    statusText: response.statusText,
    code: extractErrorCode(body) ?? fallback?.code,
    error:
      extractErrorMessage(body)
      ?? fallback?.error
      ?? (response.statusText ? response.statusText : DEFAULT_USER_ERROR),
  };
}

export { getDashboardErrorMessage };
