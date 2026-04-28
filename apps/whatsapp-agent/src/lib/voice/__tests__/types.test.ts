import { describe, expect, it } from "vitest";
import {
  getDefaultWhatsAppVoiceConfig,
  parseStoredWhatsAppVoiceConfig,
  parseWhatsAppSpeechProvider,
  resolveWhatsAppVoiceConfigForProvider,
} from "../types.js";

describe("WhatsApp voice types", () => {
  it("returns the Deepgram default voice config", () => {
    expect(getDefaultWhatsAppVoiceConfig()).toEqual({
      provider: "deepgram",
      voiceId: "aura-2-andromeda-en",
      speed: 1.2,
    });
  });

  it("parses a stored xAI voice config", () => {
    expect(parseStoredWhatsAppVoiceConfig({
      provider: "xai",
      voiceId: "eve",
      speed: 1.1,
    })).toEqual({
      provider: "xai",
      voiceId: "eve",
      speed: 1.1,
    });
  });

  it("rejects unsupported provider values", () => {
    expect(() => parseWhatsAppSpeechProvider("cartesia", "provider")).toThrow(
      'provider must be "deepgram" or "xai"'
    );
  });

  it("rejects a voice ID that does not belong to the stored provider", () => {
    expect(() => parseStoredWhatsAppVoiceConfig({
      provider: "xai",
      voiceId: "aura-2-andromeda-en",
      speed: 1.2,
    })).toThrow('The stored WhatsApp voice ID "aura-2-andromeda-en" is not supported for xai.');
  });

  it("resolves a provider mismatch to the selected provider default voice", () => {
    const resolved = resolveWhatsAppVoiceConfigForProvider(
      "xai",
      {
        provider: "deepgram",
        voiceId: "aura-2-andromeda-en",
        speed: 1.3,
      },
      {
        xaiVoiceId: "sal",
      }
    );

    expect(resolved).toEqual({
      provider: "xai",
      voiceId: "sal",
      speed: 1.3,
    });
  });
});
