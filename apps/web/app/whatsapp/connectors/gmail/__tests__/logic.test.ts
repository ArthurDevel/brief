import { describe, expect, it } from "vitest";
import {
  getGmailConnectorNotice,
  parseGmailConnectCallback,
} from "../logic";

describe("getGmailConnectorNotice", () => {
  it("returns a success notice for a completed connection", () => {
    expect(getGmailConnectorNotice({ connected: "1" })).toEqual({
      kind: "success",
      message: "Gmail is connected. Future WhatsApp requests will use your account.",
    });
  });

  it("returns a safe error notice for known codes", () => {
    expect(getGmailConnectorNotice({ error: "auth_required" })).toEqual({
      kind: "error",
      message: "Sign in with your WhatsApp number before you connect Gmail.",
    });
  });

  it("ignores unknown error codes", () => {
    expect(getGmailConnectorNotice({ error: "provider_stacktrace" })).toBeNull();
  });
});

describe("parseGmailConnectCallback", () => {
  it("accepts a success callback with a connected account id", () => {
    const params = new URLSearchParams({
      status: "success",
      connected_account_id: "conn_123",
    });

    expect(parseGmailConnectCallback(params)).toEqual({
      status: "success",
      connectedAccountId: "conn_123",
      errorCode: null,
    });
  });

  it("treats a success callback without a connected account id as invalid", () => {
    const params = new URLSearchParams({
      status: "success",
    });

    expect(parseGmailConnectCallback(params)).toEqual({
      status: "success",
      connectedAccountId: null,
      errorCode: "callback_invalid",
    });
  });

  it("maps failed callbacks to a safe error code", () => {
    const params = new URLSearchParams({
      status: "failed",
    });

    expect(parseGmailConnectCallback(params)).toEqual({
      status: "failed",
      connectedAccountId: null,
      errorCode: "connection_failed",
    });
  });
});
