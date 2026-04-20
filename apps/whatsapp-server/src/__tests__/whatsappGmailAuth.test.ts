import { describe, expect, it } from "vitest";
import {
  buildWhatsAppGmailConnectorUrl,
  isAuthenticateGmailCommand,
  normalizeWhatsAppCallerPhone,
} from "../whatsappGmailAuth.js";

describe("isAuthenticateGmailCommand", () => {
  it("matches the hardcoded gmail auth command", () => {
    expect(isAuthenticateGmailCommand(" authenticate gmail ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateGmailCommand("authenticate outlook")).toBe(false);
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
