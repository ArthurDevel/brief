import { toHttpUrl, toWebSocketUrl } from "./livekitUrls.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function splitCsv(rawValue: string | undefined, fallback: string[]): string[] {
  const value = rawValue?.trim();
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface AgentEnv {
  livekitAgentName: string;
  livekitAgentGreeting: string;
  livekitAgentInstructions: string;
  livekitHttpUrl: string;
  livekitWsUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  composioApiKey: string;
  composioUserId: string;
  composioConnectedAccountId?: string;
  composioAllowedTools: string[];
  livekitSttModel: string;
  livekitLlmModel: string;
  livekitTtsModel: string;
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
    composioApiKey: requireEnv("COMPOSIO_API_KEY"),
    composioUserId: process.env.COMPOSIO_USER_ID?.trim() || "demo",
    composioConnectedAccountId: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || undefined,
    composioAllowedTools: splitCsv(process.env.COMPOSIO_ALLOWED_TOOLS, ["HACKERNEWS_GET_LATEST_POSTS"]),
    livekitSttModel: process.env.LIVEKIT_STT_MODEL?.trim() || "deepgram/nova-3:en",
    livekitLlmModel: process.env.LIVEKIT_LLM_MODEL?.trim() || "openai/gpt-4.1-mini",
    livekitTtsModel:
      process.env.LIVEKIT_TTS_MODEL?.trim() ||
      "cartesia/sonic-3:794f9389-aac1-45b6-b726-9d9369183238"
  };

  return cachedEnv;
}
