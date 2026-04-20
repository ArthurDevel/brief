import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppConnectorOverviewUrl,
  buildWhatsAppGmailConnectorUrl,
  buildWhatsAppNotionConnectorUrl,
  isAuthenticateGmailCommand,
  isAuthenticateNotionCommand,
  isAuthenticateOverviewCommand,
  normalizeWhatsAppCallerPhone,
  sendWhatsAppGmailConnectMessage,
  sendWhatsAppNotionConnectMessage,
  sendWhatsAppOverviewMessage,
} from "../whatsappAuthCommands.js";

const TEST_MESSAGE_CONFIG = {
  accessToken: "test-access-token",
  apiVersion: "v23.0",
  phoneNumberId: "123456789",
  webBaseUrl: "https://app.example.com",
};

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("isAuthenticateNotionCommand", () => {
  it("matches the hardcoded notion auth command", () => {
    expect(isAuthenticateNotionCommand(" authenticate notion ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateNotionCommand("authenticate gmail")).toBe(false);
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

describe("buildWhatsAppNotionConnectorUrl", () => {
  it("builds the whatsapp notion connector deep link", () => {
    expect(
      buildWhatsAppNotionConnectorUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/connectors/notion?phone=%2B15551234567");
  });
});

describe("sendWhatsAppGmailConnectMessage", () => {
  it("sends the approved gmail utility template with the encoded phone variable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWhatsAppGmailConnectMessage(TEST_MESSAGE_CONFIG, "+15551234567");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "15551234567",
          type: "template",
          template: {
            name: "composio_connect_gmail",
            language: { code: "en" },
            components: [
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [
                  {
                    type: "text",
                    text: "%2B15551234567",
                  },
                ],
              },
            ],
          },
        }),
      })
    );
  });
});

describe("sendWhatsAppNotionConnectMessage", () => {
  it("sends the approved notion utility template with the encoded phone variable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWhatsAppNotionConnectMessage(TEST_MESSAGE_CONFIG, "+15551234567");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "15551234567",
          type: "template",
          template: {
            name: "composio_connect_notion",
            language: { code: "en" },
            components: [
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [
                  {
                    type: "text",
                    text: "%2B15551234567",
                  },
                ],
              },
            ],
          },
        }),
      })
    );
  });
});

describe("sendWhatsAppOverviewMessage", () => {
  it("sends the approved overview utility template with the encoded phone variable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWhatsAppOverviewMessage(TEST_MESSAGE_CONFIG, "+15551234567");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v23.0/123456789/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "15551234567",
          type: "template",
          template: {
            name: "composio_connector_overview",
            language: { code: "en" },
            components: [
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [
                  {
                    type: "text",
                    text: "%2B15551234567",
                  },
                ],
              },
            ],
          },
        }),
      })
    );
  });
});
