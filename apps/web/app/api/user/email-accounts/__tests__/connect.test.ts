import { describe, expect, it } from "vitest";
import type { EmailAccountSummary } from "@/lib/types";
import { UnipileApiError } from "@/lib/unipile/client";
import {
  normalizeConnectIntent,
  resolveSuccessRedirectUrl,
  resolveConnectMode,
  shouldRetryReconnectAsCreate,
} from "../connect/logic";

const baseAccount: EmailAccountSummary = {
  id: "acct-1",
  provider: "gmail",
  connectionType: "unipile",
  emailAddress: "user@gmail.com",
  status: "connected",
  lastError: null,
  hasImapPassword: false,
  hasSmtpPassword: false,
};

describe("normalizeConnectIntent", () => {
  it("accepts supported values", () => {
    expect(normalizeConnectIntent("create")).toBe("create");
    expect(normalizeConnectIntent("reconnect")).toBe("reconnect");
    expect(normalizeConnectIntent("auto")).toBe("auto");
  });

  it("falls back to auto for unsupported values", () => {
    expect(normalizeConnectIntent(undefined)).toBe("auto");
    expect(normalizeConnectIntent("anything-else")).toBe("auto");
  });
});

describe("resolveConnectMode", () => {
  it("uses create when explicitly requested", () => {
    expect(
      resolveConnectMode({
        intent: "create",
        provider: "gmail",
        existingAccount: baseAccount,
        reconnectAccountId: "uni-1",
      })
    ).toEqual({ type: "create" });
  });

  it("uses reconnect when intent allows it and a reconnect id exists", () => {
    expect(
      resolveConnectMode({
        intent: "reconnect",
        provider: "gmail",
        existingAccount: baseAccount,
        reconnectAccountId: "uni-1",
      })
    ).toEqual({ type: "reconnect", reconnectAccountId: "uni-1" });
  });

  it("falls back to create when reconnect intent has no reconnect id", () => {
    expect(
      resolveConnectMode({
        intent: "reconnect",
        provider: "gmail",
        existingAccount: baseAccount,
      })
    ).toEqual({ type: "create" });
  });

  it("falls back to create when the active account is a different provider", () => {
    expect(
      resolveConnectMode({
        intent: "auto",
        provider: "outlook",
        existingAccount: baseAccount,
        reconnectAccountId: "uni-1",
      })
    ).toEqual({ type: "create" });
  });
});

describe("shouldRetryReconnectAsCreate", () => {
  it("retries reconnects when Unipile says the account is missing", () => {
    const error = new UnipileApiError(
      "Unipile createHostedAuthLink failed (404)",
      404,
      "{\"detail\":\"Account not found\"}",
      "createHostedAuthLink"
    );

    expect(shouldRetryReconnectAsCreate(error, "reconnect")).toBe(true);
  });

  it("does not retry create flows", () => {
    const error = new UnipileApiError(
      "Unipile createHostedAuthLink failed (404)",
      404,
      "{\"detail\":\"Account not found\"}",
      "createHostedAuthLink"
    );

    expect(shouldRetryReconnectAsCreate(error, "create")).toBe(false);
  });

  it("does not retry unrelated errors", () => {
    const error = new UnipileApiError(
      "Unipile createHostedAuthLink failed (500)",
      500,
      "{\"detail\":\"Internal error\"}",
      "createHostedAuthLink"
    );

    expect(shouldRetryReconnectAsCreate(error, "reconnect")).toBe(false);
  });
});

describe("resolveSuccessRedirectUrl", () => {
  const appUrl = "https://app.example.com";

  it("preserves the settings query string when the return URL is valid", () => {
    expect(
      resolveSuccessRedirectUrl("/dashboard/settings?tab=email&foo=bar", appUrl)
    ).toBe("https://app.example.com/dashboard/settings?tab=email&foo=bar");
  });

  it("falls back to the email tab when the path is not the settings page", () => {
    expect(resolveSuccessRedirectUrl("/dashboard", appUrl)).toBe(
      "https://app.example.com/dashboard/settings?tab=email"
    );
  });

  it("falls back to the email tab for cross-origin URLs", () => {
    expect(resolveSuccessRedirectUrl("https://evil.example.com/dashboard/settings?tab=email", appUrl)).toBe(
      "https://app.example.com/dashboard/settings?tab=email"
    );
  });
});
