import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEnv } from "../env.js";
import { getDefaultWhatsAppVoiceConfig } from "../voice/types.js";

// ============================================================================
// MOCKS
// ============================================================================

const mockResolveOrCreateLinkedUserByPhone = vi.fn();
const mockConnectedAccountsList = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({
  maybeSingle: mockMaybeSingle,
}));
const mockSelect = vi.fn(() => ({
  eq: mockEq,
}));
const mockFrom = vi.fn(() => ({
  select: mockSelect,
}));

vi.mock("@dublin/whatsapp-core", () => {
  return {
    createWhatsAppCoreStore: vi.fn(() => ({
      resolveOrCreateLinkedUserByPhone: mockResolveOrCreateLinkedUserByPhone,
    })),
  };
});

vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: vi.fn(() => ({
      from: mockFrom,
    })),
  };
});

vi.mock("@composio/core", () => {
  class MockComposio {
    connectedAccounts = {
      list: mockConnectedAccountsList,
    };
  }

  return {
    Composio: MockComposio,
  };
});

import { resolveWhatsAppCallerContext } from "../whatsappRuntime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TEST_ENV: AgentEnv = {
  composioApiKey: "composio_test_key",
  deepgramApiKey: "deepgram_test_key",
  xaiApiKey: "xai_test_key",
  internalApiKey: "internal_test_key",
  livekitAgentGreeting: "Hello",
  livekitAgentInstructions: "Instructions",
  livekitAgentName: "whatsapp-agent",
  livekitApiKey: "livekit_api_key",
  livekitApiSecret: "livekit_api_secret",
  livekitHttpUrl: "https://livekit.example.com",
  livekitWsUrl: "wss://livekit.example.com",
  openRouterApiKey: "openrouter_test_key",
  supabaseServiceRoleKey: "supabase_service_role_key",
  supabaseUrl: "https://supabase.example.com",
  webAppUrl: "https://app.example.com",
  whatsappAccessToken: "whatsapp_access_token",
  whatsappApiVersion: "23",
  whatsappDeepgramSttModel: "deepgram/nova-3:en",
  whatsappDefaultDeepgramVoice: "aura-2-andromeda-en",
  whatsappDefaultXaiVoice: "ara",
  whatsappPhoneNumberId: "123456789",
  whatsappSttProvider: "deepgram",
  whatsappTtsProvider: "deepgram",
  whatsappXaiSttModel: "xai/stt-1:en",
};

// ============================================================================
// TESTS
// ============================================================================

describe("resolveWhatsAppCallerContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a linked user for a first-time caller before loading voice context", async () => {
    mockResolveOrCreateLinkedUserByPhone.mockResolvedValue({
      userId: "user-1",
      whatsappPhone: "+15551234567",
    });
    mockMaybeSingle.mockResolvedValue({
      data: {
        user_id: "user-1",
        whatsapp_voice_config: null,
      },
      error: null,
    });
    mockConnectedAccountsList.mockResolvedValue({
      items: [],
    });

    const result = await resolveWhatsAppCallerContext(
      TEST_ENV,
      JSON.stringify({
        caller: "+15551234567",
      })
    );

    expect(mockResolveOrCreateLinkedUserByPhone).toHaveBeenCalledWith("+15551234567");
    expect(mockFrom).toHaveBeenCalledWith("user_settings");
    expect(mockSelect).toHaveBeenCalledWith("user_id, whatsapp_voice_config");
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(result).toEqual({
      callerPhone: "+15551234567",
      connectionGuidanceMessage:
        "You do not have any connected apps yet. Send authenticate overview in WhatsApp and connect one first.",
      connectedAccountsByToolkit: {},
      supabaseUserId: "user-1",
      voiceConfig: getDefaultWhatsAppVoiceConfig(),
    });
  });

  it("keeps the latest active connection per toolkit for an existing caller", async () => {
    mockResolveOrCreateLinkedUserByPhone.mockResolvedValue({
      userId: "user-2",
      whatsappPhone: "+15559876543",
    });
    mockMaybeSingle.mockResolvedValue({
      data: {
        user_id: "user-2",
        whatsapp_voice_config: {
          provider: "deepgram",
          speed: 1.3,
          voiceId: "aura-2-andromeda-en",
        },
      },
      error: null,
    });
    mockConnectedAccountsList.mockResolvedValue({
      items: [
        {
          id: "gmail-old",
          status: "ACTIVE",
          statusReason: null,
          toolkit: {
            slug: "gmail",
          },
          updatedAt: "2026-04-20T09:00:00.000Z",
        },
        {
          id: "gmail-new",
          status: "ACTIVE",
          statusReason: null,
          toolkit: {
            slug: "gmail",
          },
          updatedAt: "2026-04-21T09:00:00.000Z",
        },
        {
          id: "calendar-pending",
          status: "INITIATED",
          statusReason: null,
          toolkit: {
            slug: "googlecalendar",
          },
          updatedAt: "2026-04-22T09:00:00.000Z",
        },
      ],
    });

    const result = await resolveWhatsAppCallerContext(
      TEST_ENV,
      JSON.stringify({
        caller: "+15559876543",
      })
    );

    expect(result).toEqual({
      callerPhone: "+15559876543",
      connectionGuidanceMessage: null,
      connectedAccountsByToolkit: {
        gmail: "gmail-new",
      },
      supabaseUserId: "user-2",
      voiceConfig: {
        provider: "deepgram",
        speed: 1.3,
        voiceId: "aura-2-andromeda-en",
      },
    });
  });
});
