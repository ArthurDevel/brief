import { describe, expect, it } from "vitest";
import {
  getConnectionErrorMessage,
  getEmailStatusFromTestResult,
  getStoredEmailStatus,
} from "../email-status";

describe("email status helpers", () => {
  it("maps stored reconnect status without collapsing it to error", () => {
    expect(
      getStoredEmailStatus({
        status: "reconnect_required",
        lastError: "OAuth token expired",
      })
    ).toEqual({
      status: "reconnect_required",
      message: "OAuth token expired",
    });
  });

  it("treats smtp-only failures as a broken connection", () => {
    expect(
      getEmailStatusFromTestResult({
        imap: { ok: true },
        smtp: { ok: false, error: "535 Authentication failed" },
      })
    ).toEqual({
      status: "error",
      message: "535 Authentication failed",
    });
  });

  it("preserves reconnect_required from live Unipile checks", () => {
    expect(
      getEmailStatusFromTestResult({
        status: "reconnect_required",
        imap: { ok: false, error: "Unipile account status: reconnect_required" },
        smtp: { ok: false, error: "Unipile account status: reconnect_required" },
      })
    ).toEqual({
      status: "reconnect_required",
      message: "Unipile account status: reconnect_required",
    });
  });

  it("combines distinct protocol failures into one message", () => {
    expect(
      getConnectionErrorMessage({
        imap: { ok: false, error: "Invalid IMAP credentials" },
        smtp: { ok: false, error: "SMTP timeout" },
      })
    ).toBe("Incoming mail: Invalid IMAP credentials. Outgoing mail: SMTP timeout");
  });
});
