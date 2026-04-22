import { describe, expect, it } from "vitest";
import {
  buildWhatsAppTextSystemPrompt,
  buildWhatsAppTextUserPrompt,
} from "../text/promptBuilder.js";

describe("buildWhatsAppTextSystemPrompt", () => {
  it("requires tool calls for WhatsApp text interaction", () => {
    expect(buildWhatsAppTextSystemPrompt()).toContain(
      "Always communicate with the user through the available tools."
    );
    expect(buildWhatsAppTextSystemPrompt()).toContain(
      "Use send_message_to_agent whenever a task needs external app access"
    );
    expect(buildWhatsAppTextSystemPrompt()).toContain(
      "Use send_whatsapp_auth_template when the user asks to connect Gmail"
    );
  });
});

describe("buildWhatsAppTextUserPrompt", () => {
  it("renders prior messages as history and keeps the current turn separate", () => {
    const prompt = buildWhatsAppTextUserPrompt({
      conversationHistory: [
        {
          id: "msg-1",
          contactPhoneNumber: "+15551234567",
          createdAt: "2026-04-22T10:00:00.000Z",
          direction: "inbound",
          metaMessageId: "wamid.1",
          status: "received",
          text: "previous user message",
          userId: "user-1",
        },
        {
          id: "msg-2",
          contactPhoneNumber: "+15551234567",
          createdAt: "2026-04-22T10:00:10.000Z",
          direction: "outbound",
          metaMessageId: null,
          status: "sent",
          text: "previous assistant reply",
          userId: "user-1",
        },
      ],
      currentMessage: {
        id: "msg-3",
        contactPhoneNumber: "+15551234567",
        createdAt: "2026-04-22T10:00:20.000Z",
        direction: "inbound",
        metaMessageId: "wamid.3",
        status: "received",
        text: "current user message",
        userId: "user-1",
      },
      linkedUser: {
        userId: "user-1",
        whatsappPhone: "+15551234567",
      },
      memoryEntries: [
        {
          id: "memory-1",
          content: "Prefers short answers",
        },
      ],
    });

    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("<user_message timestamp=\"2026-04-22T10:00:00.000Z\">");
    expect(prompt).toContain("<poke_reply timestamp=\"2026-04-22T10:00:10.000Z\">");
    expect(prompt).toContain("<new_user_message>\ncurrent user message\n</new_user_message>");
    expect(prompt).toContain("<user_memory>\n- Prefers short answers\n</user_memory>");
    expect(prompt).not.toContain("msg-3");
  });
});
