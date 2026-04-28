import { describe, expect, it } from "vitest";
import type { AgentEnv } from "../../env.js";
import {
  createWhatsAppStt,
  createWhatsAppTts,
} from "../factory.js";
import { getDefaultWhatsAppVoiceConfig } from "../types.js";

const BASE_ENV: AgentEnv = {
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

describe("WhatsApp voice provider factory", () => {
  it("returns the configured Deepgram STT descriptor", () => {
    expect(createWhatsAppStt(BASE_ENV)).toBe("deepgram/nova-3:en");
  });

  it("returns the configured xAI STT descriptor", () => {
    expect(createWhatsAppStt({
      ...BASE_ENV,
      whatsappSttProvider: "xai",
    })).toBe("xai/stt-1:en");
  });

  it("creates Deepgram TTS with the stored Deepgram voice", () => {
    const tts = createWhatsAppTts(BASE_ENV, getDefaultWhatsAppVoiceConfig());

    expect(tts.provider).toBe("Deepgram+WSOLA");
    expect(tts.model).toBe("aura-2-andromeda-en");
  });

  it("creates xAI TTS with the configured xAI default when stored voice is Deepgram", () => {
    const tts = createWhatsAppTts(
      {
        ...BASE_ENV,
        whatsappTtsProvider: "xai",
        whatsappDefaultXaiVoice: "sal",
      },
      getDefaultWhatsAppVoiceConfig()
    );

    expect(tts.provider).toBe("xAI+WSOLA");
    expect(tts.model).toBe("sal");
  });

  it("throws when the selected Deepgram provider is missing its API key", () => {
    expect(() => createWhatsAppTts({
      ...BASE_ENV,
      deepgramApiKey: undefined,
    }, getDefaultWhatsAppVoiceConfig())).toThrow(
      "DEEPGRAM_API_KEY is required for the selected WhatsApp voice provider."
    );
  });

  it("throws when the selected xAI provider is missing its API key", () => {
    expect(() => createWhatsAppTts({
      ...BASE_ENV,
      xaiApiKey: undefined,
      whatsappTtsProvider: "xai",
    }, getDefaultWhatsAppVoiceConfig())).toThrow(
      "XAI_API_KEY is required for the selected WhatsApp voice provider."
    );
  });
});
