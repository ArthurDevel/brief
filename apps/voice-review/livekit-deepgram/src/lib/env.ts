import { DEFAULT_PORT } from "../shared/constants.js";
import { toHttpUrl, toWebSocketUrl } from "./livekitUrls.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export interface AppEnv {
  port: number;
  deepgramApiKey: string;
  openrouterApiKey: string;
  openrouterModel: string;
  livekitHttpUrl: string;
  livekitWsUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const livekitUrl = requireEnv("LIVEKIT_URL");
  const portValue = process.env.PORT?.trim();
  const parsedPort = portValue ? Number(portValue) : DEFAULT_PORT;

  if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  cachedEnv = {
    port: parsedPort,
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    openrouterModel: process.env.OPENROUTER_MODEL?.trim() || "google/gemini-3-flash-preview",
    livekitHttpUrl: toHttpUrl(livekitUrl),
    livekitWsUrl: toWebSocketUrl(livekitUrl),
    livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
    livekitApiSecret: requireEnv("LIVEKIT_API_SECRET")
  };

  return cachedEnv;
}
