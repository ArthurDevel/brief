import { toHttpUrl, toWebSocketUrl } from "./livekitUrls.js";
import { getDefaultWhatsAppApiVersion } from "./whatsappCustomTools.js";
import type { LlmProvider } from "@dublin/llm/types";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export interface AgentEnv {
  livekitAgentName: string;
  livekitAgentGreeting: string;
  livekitAgentInstructions: string;
  livekitHttpUrl: string;
  livekitWsUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  cerebrasApiKey?: string;
  openRouterApiKey?: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  composioApiKey: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappApiVersion: string;
  deepgramApiKey?: string;
  xaiApiKey?: string;
  whatsappSttProvider: string;
  whatsappTtsProvider: string;
  whatsappDeepgramSttModel: string;
  whatsappXaiSttModel: string;
  whatsappDefaultDeepgramVoice: string;
  whatsappDefaultXaiVoice: string;
  webAppUrl: string;
  internalApiKey: string;
}

let cachedEnv: AgentEnv | null = null;

export function getEnv(): AgentEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const livekitUrl = requireEnv("LIVEKIT_URL");

  cachedEnv = {
    livekitAgentName: process.env.LIVEKIT_AGENT_NAME?.trim() || "whatsapp-composio-agent",
    livekitAgentGreeting:
      process.env.LIVEKIT_AGENT_GREETING?.trim() ||
      "Greet the caller briefly and ask how you can help.",
    livekitAgentInstructions:
      process.env.LIVEKIT_AGENT_INSTRUCTIONS?.trim() ||
      "You are a concise voice assistant on a WhatsApp phone call. Keep responses short and spoken-language friendly.",
    livekitHttpUrl: toHttpUrl(livekitUrl),
    livekitWsUrl: toWebSocketUrl(livekitUrl),
    livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
    livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),
    cerebrasApiKey: readOptionalEnv("CEREBRAS_API_KEY"),
    openRouterApiKey: readOptionalEnv("OPENROUTER_API_KEY"),
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    composioApiKey: requireEnv("COMPOSIO_API_KEY"),
    whatsappAccessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    whatsappPhoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    whatsappApiVersion:
      process.env.WHATSAPP_API_VERSION?.trim() || getDefaultWhatsAppApiVersion(),
    deepgramApiKey: process.env.DEEPGRAM_API_KEY?.trim() || undefined,
    xaiApiKey: process.env.XAI_API_KEY?.trim() || undefined,
    whatsappSttProvider: process.env.WHATSAPP_STT_PROVIDER?.trim() || "deepgram",
    whatsappTtsProvider: process.env.WHATSAPP_TTS_PROVIDER?.trim() || "deepgram",
    whatsappDeepgramSttModel:
      process.env.WHATSAPP_DEEPGRAM_STT_MODEL?.trim() || "deepgram/nova-3:en",
    whatsappXaiSttModel:
      process.env.WHATSAPP_XAI_STT_MODEL?.trim() || "xai/stt-1:en",
    whatsappDefaultDeepgramVoice:
      process.env.WHATSAPP_DEFAULT_DEEPGRAM_VOICE?.trim() || "aura-2-andromeda-en",
    whatsappDefaultXaiVoice:
      process.env.WHATSAPP_DEFAULT_XAI_VOICE?.trim() || "ara",
    webAppUrl: requireEnv("WEB_APP_URL"),
    internalApiKey: requireEnv("INTERNAL_API_KEY"),
  };

  return cachedEnv;
}

/**
 * Returns the API key for the selected LLM provider.
 * @param provider - Selected provider constant
 * @returns Provider API key
 */
export function getLlmApiKey(provider: LlmProvider): string {
  const env = getEnv();

  if (provider === "openrouter") {
    if (!env.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY environment variable is required for OpenRouter.");
    }

    return env.openRouterApiKey;
  }

  if (provider === "cerebras") {
    if (!env.cerebrasApiKey) {
      throw new Error("CEREBRAS_API_KEY environment variable is required for Cerebras.");
    }

    return env.cerebrasApiKey;
  }

  throw new Error(`LLM provider "${provider}" is not supported by the WhatsApp agent env.`);
}

/**
 * Reads one optional environment variable.
 * @param name - Environment variable name
 * @returns Trimmed value, or undefined when missing
 */
function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }

  return value;
}
