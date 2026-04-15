import type { EmailAccountSummary } from "@/lib/types";
import { UnipileApiError } from "@/lib/unipile/client";

export type ConnectIntent = "auto" | "create" | "reconnect";
export type HostedAuthType = "create" | "reconnect";

interface ResolveConnectModeInput {
  intent: ConnectIntent;
  provider: "gmail" | "outlook";
  existingAccount: EmailAccountSummary | null;
  reconnectAccountId?: string;
}

interface ResolveConnectModeResult {
  type: HostedAuthType;
  reconnectAccountId?: string;
}

export function normalizeConnectIntent(value: unknown): ConnectIntent {
  if (value === "auto" || value === "create" || value === "reconnect") {
    return value;
  }

  return "auto";
}

export function resolveConnectMode(
  input: ResolveConnectModeInput
): ResolveConnectModeResult {
  const canReconnect =
    input.existingAccount?.connectionType === "unipile" &&
    input.existingAccount.provider === input.provider &&
    Boolean(input.reconnectAccountId);

  if (input.intent === "create" || !canReconnect) {
    return { type: "create" };
  }

  return {
    type: "reconnect",
    reconnectAccountId: input.reconnectAccountId,
  };
}

export function shouldRetryReconnectAsCreate(
  error: unknown,
  type: HostedAuthType
): boolean {
  return (
    type === "reconnect" &&
    error instanceof UnipileApiError &&
    error.status === 404 &&
    error.body.toLowerCase().includes("account not found")
  );
}

export function resolveSuccessRedirectUrl(
  value: unknown,
  appUrl: string
): string {
  const fallbackUrl = new URL("/dashboard/settings?tab=email", appUrl);

  if (typeof value !== "string" || value.length === 0) {
    return fallbackUrl.toString();
  }

  try {
    const appOrigin = new URL(appUrl).origin;
    const candidateUrl = new URL(value, appUrl);

    if (candidateUrl.origin !== appOrigin || candidateUrl.pathname !== "/dashboard/settings") {
      return fallbackUrl.toString();
    }

    return candidateUrl.toString();
  } catch {
    return fallbackUrl.toString();
  }
}
