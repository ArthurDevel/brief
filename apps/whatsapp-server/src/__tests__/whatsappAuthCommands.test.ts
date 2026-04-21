import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppConnectorOverviewUrl,
  buildWhatsAppGmailConnectorUrl,
  buildWhatsAppGoogleCalendarConnectorUrl,
  buildWhatsAppNotionConnectorUrl,
  buildWhatsAppOutlookConnectorUrl,
  buildWhatsAppVoiceSettingsUrl,
  isAuthenticateGmailCommand,
  isAuthenticateGoogleCalendarCommand,
  isAuthenticateNotionCommand,
  isAuthenticateOutlookCommand,
  isAuthenticateOverviewCommand,
  isVoiceSettingsCommand,
  normalizeWhatsAppCallerPhone,
  sendWhatsAppGmailConnectMessage,
  sendWhatsAppGoogleCalendarConnectMessage,
  sendWhatsAppNotionConnectMessage,
  sendWhatsAppOutlookConnectMessage,
  sendWhatsAppOverviewMessage,
  sendWhatsAppVoiceSettingsMessage,
} from "../whatsappAuthCommands.js";
import type { WhatsAppTransport } from "../whatsappTransport.js";

const TEST_MESSAGE_CONFIG = {
  accessToken: "test-access-token",
  apiVersion: "v23.0",
  phoneNumberId: "123456789",
  webBaseUrl: "https://app.example.com",
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Creates a transport mock for auth-command delivery tests.
 * @returns Transport mock
 */
function createTransportMock(): WhatsAppTransport {
  return {
    mode: "meta",
    acceptCall: vi.fn(),
    getMediaById: vi.fn(),
    preAcceptCall: vi.fn(),
    rejectCall: vi.fn(),
    sendTemplateMessage: vi.fn().mockResolvedValue(undefined),
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
  };
}

describe("isAuthenticateGmailCommand", () => {
  it("matches the hardcoded gmail auth command", () => {
    expect(isAuthenticateGmailCommand(" authenticate gmail ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateGmailCommand("authenticate outlook")).toBe(false);
  });
});

describe("isAuthenticateGoogleCalendarCommand", () => {
  it("matches the hardcoded google calendar auth command", () => {
    expect(isAuthenticateGoogleCalendarCommand(" authenticate google calendar ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateGoogleCalendarCommand("authenticate gmail")).toBe(false);
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

describe("isAuthenticateOutlookCommand", () => {
  it("matches the hardcoded outlook auth command", () => {
    expect(isAuthenticateOutlookCommand(" authenticate outlook ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAuthenticateOutlookCommand("authenticate notion")).toBe(false);
  });
});

describe("isVoiceSettingsCommand", () => {
  it("matches the hardcoded voice settings command", () => {
    expect(isVoiceSettingsCommand(" voice settings ")).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isVoiceSettingsCommand("authenticate overview")).toBe(false);
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

describe("buildWhatsAppGoogleCalendarConnectorUrl", () => {
  it("builds the whatsapp google calendar connector deep link", () => {
    expect(
      buildWhatsAppGoogleCalendarConnectorUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/connectors/googlecalendar?phone=%2B15551234567");
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

describe("buildWhatsAppOutlookConnectorUrl", () => {
  it("builds the whatsapp outlook connector deep link", () => {
    expect(
      buildWhatsAppOutlookConnectorUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/connectors/outlook?phone=%2B15551234567");
  });
});

describe("buildWhatsAppVoiceSettingsUrl", () => {
  it("builds the whatsapp voice settings deep link", () => {
    expect(
      buildWhatsAppVoiceSettingsUrl("https://app.example.com", "+15551234567")
    ).toBe("https://app.example.com/whatsapp/settings/voice?phone=%2B15551234567");
  });
});

describe("sendWhatsAppGmailConnectMessage", () => {
  it("sends the approved gmail utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppGmailConnectMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Connect Gmail: https://app.example.com/whatsapp/connectors/gmail?phone=%2B15551234567",
      templateName: "composio_connect_gmail",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});

describe("sendWhatsAppGoogleCalendarConnectMessage", () => {
  it("sends the approved google calendar utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppGoogleCalendarConnectMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Connect Google Calendar: https://app.example.com/whatsapp/connectors/googlecalendar?phone=%2B15551234567",
      templateName: "composio_connect_google_calendar",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});

describe("sendWhatsAppNotionConnectMessage", () => {
  it("sends the approved notion utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppNotionConnectMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Connect Notion: https://app.example.com/whatsapp/connectors/notion?phone=%2B15551234567",
      templateName: "composio_connect_notion",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});

describe("sendWhatsAppOutlookConnectMessage", () => {
  it("sends the approved outlook utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppOutlookConnectMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Connect Outlook: https://app.example.com/whatsapp/connectors/outlook?phone=%2B15551234567",
      templateName: "composio_connect_outlook",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});

describe("sendWhatsAppOverviewMessage", () => {
  it("sends the approved overview utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppOverviewMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Connected apps overview: https://app.example.com/whatsapp/connectors/overview?phone=%2B15551234567",
      templateName: "composio_connector_overview",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});

describe("sendWhatsAppVoiceSettingsMessage", () => {
  it("sends the approved voice settings utility template with the encoded phone variable", async () => {
    const transport = createTransportMock();

    await sendWhatsAppVoiceSettingsMessage(transport, TEST_MESSAGE_CONFIG, "+15551234567");

    expect(transport.sendTemplateMessage).toHaveBeenCalledWith({
      fallbackText: "Voice settings: https://app.example.com/whatsapp/settings/voice?phone=%2B15551234567",
      templateName: "voice_settings",
      to: "+15551234567",
      urlVariable: "%2B15551234567",
    });
  });
});
