import { toHttpUrl, toWebSocketUrl } from "./livekitUrls.js";
import { getDefaultWhatsAppApiVersion } from "./whatsappCustomTools.js";

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
  openRouterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  composioApiKey: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappApiVersion: string;
  deepgramApiKey: string;
  livekitSttModel: string;
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
    openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    composioApiKey: requireEnv("COMPOSIO_API_KEY"),
    whatsappAccessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    whatsappPhoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    whatsappApiVersion:
      process.env.WHATSAPP_API_VERSION?.trim() || getDefaultWhatsAppApiVersion(),
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    livekitSttModel: process.env.LIVEKIT_STT_MODEL?.trim() || "deepgram/nova-3:en",
    webAppUrl: requireEnv("WEB_APP_URL"),
    internalApiKey: requireEnv("INTERNAL_API_KEY"),
  };

  return cachedEnv;
}
