import { describe, expect, it } from "vitest";
import { buildAssistantInstructions } from "../assistantInstructions.js";
import { getDefaultWhatsAppVoiceConfig } from "../whatsappVoice.js";

describe("buildAssistantInstructions", () => {
  it("lists the caller's connected apps when active accounts exist", () => {
    const instructions = buildAssistantInstructions("Base instructions.", {
      callerPhone: "+15551234567",
      connectionGuidanceMessage: null,
      connectedAccountsByToolkit: {
        gmail: "ca_gmail",
        notion: "ca_notion",
      },
      supabaseUserId: "user_123",
      voiceConfig: getDefaultWhatsAppVoiceConfig(),
    });

    expect(instructions).toContain("Base instructions.");
    expect(instructions).toContain("Connected apps for this caller: Gmail, Notion.");
    expect(instructions).toContain("LOCAL_SEND_WHATSAPP_AUTH_TEMPLATE");
    expect(instructions).not.toContain("This caller does not have any active connected apps yet.");
  });

  it("includes the missing-connection guidance when no accounts are active", () => {
    const instructions = buildAssistantInstructions("Base instructions.", {
      callerPhone: "+15551234567",
      connectionGuidanceMessage:
        "You do not have any connected apps yet. Send authenticate overview in WhatsApp and connect one first.",
      connectedAccountsByToolkit: {},
      supabaseUserId: "user_123",
      voiceConfig: getDefaultWhatsAppVoiceConfig(),
    });

    expect(instructions).toContain("This caller does not have any active connected apps yet.");
    expect(instructions).toContain("LOCAL_SEND_WHATSAPP_CONNECTOR_OVERVIEW");
    expect(instructions).toContain("You do not have any connected apps yet.");
  });
});
