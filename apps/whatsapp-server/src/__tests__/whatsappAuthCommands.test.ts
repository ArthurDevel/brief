import { describe, expect, it } from "vitest";
import {
  buildWhatsAppConnectorOverviewUrl,
  buildWhatsAppGmailConnectorUrl,
  isAuthenticateGmailCommand,
  isAuthenticateOverviewCommand,
  normalizeWhatsAppCallerPhone,
} from "../whatsappAuthCommands.js";

describe("isAuthenticateGmailCommand", () => {
  it("matches the hardcoded gmail auth command", () => {
    expect(isAuthenticateGmailCommand(" authenticate gmail ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateGmailCommand("authenticate outlook")).toBe(false);
  });
});

describe("isAuthenticateOverviewCommand", () => {
  it("matches the hardcoded overview auth command", () => {
    expect(isAuthenticateOverviewCommand(" authenticate overview ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateOverviewCommand("authenticate gmail")).toBe(false);
  });
});

describe("normalizeWhatsAppCallerPhone", () => {
  it("normalizes digit-only whatsapp senders to E.164", () => {
    expect(normalizeWhatsAppCallerPhone("15551234567")).toBe("+15551234567");
  });

  it("rejects invalid phone values", () => {
    expect(normalizeWhatsAppCallerPhone("123")).toBeNull();
  });
});

describe("buildWhatsAppGmailConnectorUrl", () => {
  it("builds the whatsapp gmail connector deep link", () => {
    expect(
      buildWhatsAppGmailConnectorUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/connectors/gmail?phone=%2B15551234567");
  });
});

describe("buildWhatsAppConnectorOverviewUrl", () => {
  it("builds the whatsapp connectors overview deep link", () => {
    expect(
      buildWhatsAppConnectorOverviewUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/connectors/overview?phone=%2B15551234567");
  });
});
