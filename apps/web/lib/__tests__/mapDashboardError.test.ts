import { describe, expect, it, vi } from "vitest";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
  mapDashboardError,
  mapDashboardErrorDetails,
} from "../errors/mapDashboardError";

describe("mapDashboardError", () => {
  it("prefers explicit stable codes from API payloads", () => {
    expect(
      mapDashboardError(
        { code: "EMAIL_CONNECT_FAILED", error: "technical provider text" },
        "settings-email"
      )
    ).toBe("We couldn't start the email connection flow. Please try again.");
  });

  it("maps raw IMAP auth failures to the safe inbox message", () => {
    expect(
      mapDashboardError(
        "AUTHENTICATIONFAILED Invalid credentials for IMAP login",
        "settings-email",
        "EMAIL_INBOX_VERIFY_FAILED"
      )
    ).toBe(
      "Your settings were saved, but we couldn't verify your inbox connection. Please double-check your credentials."
    );
  });

  it("maps missing folders to the safe action message", () => {
    expect(
      mapDashboardError(
        'Folder "Archive/2024" does not exist on the server',
        "action-approve",
        "ACTION_EXECUTION_FAILED"
      )
    ).toBe("That folder is no longer available.");
  });

  it("maps browser microphone permission errors", () => {
    expect(
      mapDashboardError(
        { name: "NotAllowedError", message: "Permission denied" },
        "call",
        "CALL_START_FAILED"
      )
    ).toBe("We couldn't access your microphone. Please check your browser permissions.");
  });

  it("maps duplicate phone number errors to the explicit settings message", () => {
    expect(
      mapDashboardError(
        {
          error: "duplicate key value violates unique constraint \"idx_user_settings_phone_number\"",
        },
        "settings-general",
        "PHONE_SAVE_FAILED"
      )
    ).toBe("This phone number is already used by another account. Please use another number.");
  });

  it("falls back to the provided safe code for unknown errors", () => {
    expect(
      mapDashboardError(
        { error: "opaque upstream failure" },
        "settings-feature-requests",
        "FEATURE_REQUEST_SUBMIT_FAILED"
      )
    ).toBe("We couldn't submit your feature request. Please try again.");
  });

  it("returns both code and message for callers that need structured data", () => {
    expect(
      mapDashboardErrorDetails(
        { error: "usage_limit_exceeded" },
        "call-trigger",
        "CALL_TRIGGER_FAILED"
      )
    ).toEqual({
      code: "USAGE_LIMIT_REACHED",
      message: "You've reached your monthly call limit. Upgrade to keep calling.",
    });
  });
});

describe("logAndMapDashboardError", () => {
  it("logs the original error before returning the safe message", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const message = logAndMapDashboardError(
      { error: "Action not found" },
      "action-approve",
      "ACTION_APPROVE_FAILED"
    );

    expect(message).toBe("That action is no longer available.");
    expect(spy).toHaveBeenCalledWith("[dashboard-error]", {
      context: "action-approve",
      code: "ACTION_NOT_FOUND",
      message: "That action is no longer available.",
      error: { error: "Action not found" },
    });

    spy.mockRestore();
  });
});

describe("buildDashboardErrorFromResponse", () => {
  it("preserves code and error from API responses", async () => {
    const response = new Response(
      JSON.stringify({ code: "ACTION_APPROVE_FAILED", error: "safe route message" }),
      { status: 500, statusText: "Internal Server Error" }
    );

    await expect(buildDashboardErrorFromResponse(response)).resolves.toEqual({
      status: 500,
      statusText: "Internal Server Error",
      code: "ACTION_APPROVE_FAILED",
      error: "safe route message",
    });
  });
});
