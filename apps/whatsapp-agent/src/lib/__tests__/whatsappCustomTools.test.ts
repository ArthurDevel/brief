import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "../env.js";
import { createWhatsAppCustomTools } from "../whatsappCustomTools.js";
import { getDefaultWhatsAppVoiceConfig } from "../voice/types.js";

const TEST_ENV: AgentEnv = {
  livekitAgentName: "whatsapp-composio-agent",
  livekitAgentGreeting: "Hello",
  livekitAgentInstructions: "Instructions",
  livekitHttpUrl: "https://livekit.example.com",
  livekitWsUrl: "wss://livekit.example.com",
  livekitApiKey: "lk_key",
  livekitApiSecret: "lk_secret",
  openRouterApiKey: "openrouter_key",
  supabaseUrl: "https://supabase.example.com",
  supabaseServiceRoleKey: "supabase_secret",
  composioApiKey: "composio_key",
  whatsappAccessToken: "wa_access",
  whatsappPhoneNumberId: "123456789",
  whatsappApiVersion: "23",
  deepgramApiKey: "deepgram_key",
  xaiApiKey: "xai_key",
  whatsappSttProvider: "deepgram",
  whatsappTtsProvider: "deepgram",
  whatsappDeepgramSttModel: "deepgram/nova-3:en",
  whatsappXaiSttModel: "xai/stt-1:en",
  whatsappDefaultDeepgramVoice: "aura-2-andromeda-en",
  whatsappDefaultXaiVoice: "ara",
  webAppUrl: "https://app.example.com",
  internalApiKey: "internal_key",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWhatsAppCustomTools", () => {
  it("creates the auth and overview custom tools", () => {
    const tools = createWhatsAppCustomTools(TEST_ENV, {
      callerPhone: "+15551234567",
      connectionGuidanceMessage: null,
      connectedAccountsByToolkit: {},
      supabaseUserId: "user_123",
      voiceConfig: getDefaultWhatsAppVoiceConfig(),
    });

    expect(tools.map((tool) => tool.slug)).toEqual([
      "SEND_WHATSAPP_AUTH_TEMPLATE",
      "SEND_WHATSAPP_CONNECTOR_OVERVIEW",
    ]);
  });

  it("sends the notion auth template through the custom tool execute function", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tools = createWhatsAppCustomTools(TEST_ENV, {
      callerPhone: "+15551234567",
      connectionGuidanceMessage: null,
      connectedAccountsByToolkit: {},
      supabaseUserId: "user_123",
      voiceConfig: getDefaultWhatsAppVoiceConfig(),
    });

    const authTool = tools.find((tool) => tool.slug === "SEND_WHATSAPP_AUTH_TEMPLATE");
    if (!authTool) {
      throw new Error("Expected SEND_WHATSAPP_AUTH_TEMPLATE to exist.");
    }

    const result = await authTool.execute(
      { toolkit: "notion" },
      {} as never
    );

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
    expect(result).toEqual({
      message: "Sent the WhatsApp notion connection template to the caller.",
      recipientPhone: "+15551234567",
      toolkit: "notion",
    });
  });
});
