import type { EmailAccountSummary } from "@/lib/types";

export type EmailStatus =
  | "not_configured"
  | "connected"
  | "error"
  | "reconnect_required";

export interface EmailStatusResult {
  status: EmailStatus;
  message?: string;
}

export interface EmailConnectionProtocolResult {
  ok: boolean;
  error?: string;
}

export interface EmailConnectionTestResult {
  status?: EmailStatus;
  imap: EmailConnectionProtocolResult;
  smtp: EmailConnectionProtocolResult;
}

export function getStoredEmailStatus(
  account: Pick<EmailAccountSummary, "status" | "lastError"> | null | undefined
): EmailStatusResult {
  if (!account) {
    return { status: "not_configured" };
  }

  switch (account.status) {
    case "connected":
      return { status: "connected" };
    case "reconnect_required":
      return {
        status: "reconnect_required",
        message: account.lastError ?? undefined,
      };
    case "error":
      return { status: "error", message: account.lastError ?? undefined };
    case "pending":
    case "not_configured":
    default:
      return { status: "not_configured" };
  }
}

export function getEmailStatusFromTestResult(
  result: EmailConnectionTestResult
): EmailStatusResult {
  const status =
    result.status ?? (result.imap.ok && result.smtp.ok ? "connected" : "error");

  if (status === "connected") {
    return { status: "connected" };
  }

  const message =
    getConnectionErrorMessage(result) ??
    (status === "reconnect_required"
      ? "Your email account needs to be reconnected."
      : "Could not connect to your email account.");

  return { status, message };
}

export function getConnectionErrorMessage(
  result: Pick<EmailConnectionTestResult, "imap" | "smtp">
): string | undefined {
  const failures = [
    { label: "Incoming mail", ...result.imap },
    { label: "Outgoing mail", ...result.smtp },
  ].filter((entry) => !entry.ok);

  if (failures.length === 0) {
    return undefined;
  }

  const normalizedErrors = failures
    .map((entry) => entry.error?.trim())
    .filter((error): error is string => Boolean(error));

  const uniqueErrors = [...new Set(normalizedErrors)];
  if (uniqueErrors.length === 1) {
    return uniqueErrors[0];
  }

  return failures
    .map((entry) => `${entry.label}: ${entry.error ?? "Connection failed"}`)
    .join(". ");
}
