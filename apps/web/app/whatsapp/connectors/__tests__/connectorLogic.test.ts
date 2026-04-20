import { describe, expect, it } from "vitest";
import {
  getWhatsAppConnectorDefinition,
} from "../connectorDefinitions";
import {
  getConnectorNotice,
  parseConnectorCallback,
} from "../connectorLogic";

describe("getConnectorNotice", () => {
  it("returns a success notice for a completed Gmail connection", () => {
    const definition = getWhatsAppConnectorDefinition("gmail");

    expect(getConnectorNotice(definition, { connected: "1" })).toEqual({
      kind: "success",
      message: "Gmail is connected. Future WhatsApp requests will use your account.",
    });
  });

  it("returns a safe error notice for a Notion auth failure", () => {
    const definition = getWhatsAppConnectorDefinition("notion");

    expect(getConnectorNotice(definition, { error: "auth_required" })).toEqual({
      kind: "error",
      message: "Sign in with your WhatsApp number before you connect Notion.",
    });
  });

  it("ignores unknown error codes", () => {
    const definition = getWhatsAppConnectorDefinition("gmail");

    expect(getConnectorNotice(definition, { error: "provider_stacktrace" })).toBeNull();
  });
});

describe("parseConnectorCallback", () => {
  it("accepts a success callback with a connected account id", () => {
    const params = new URLSearchParams({
      status: "success",
      connected_account_id: "conn_123",
    });

    expect(parseConnectorCallback(params)).toEqual({
      status: "success",
      connectedAccountId: "conn_123",
      errorCode: null,
    });
  });

  it("treats a success callback without a connected account id as invalid", () => {
    const params = new URLSearchParams({
      status: "success",
    });

    expect(parseConnectorCallback(params)).toEqual({
      status: "success",
      connectedAccountId: null,
      errorCode: "callback_invalid",
    });
  });

  it("maps failed callbacks to a safe error code", () => {
    const params = new URLSearchParams({
      status: "failed",
    });

    expect(parseConnectorCallback(params)).toEqual({
      status: "failed",
      connectedAccountId: null,
      errorCode: "connection_failed",
    });
  });
});
