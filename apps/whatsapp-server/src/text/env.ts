import type { LlmProvider } from "@dublin/llm/types";

/**
 * Environment loader for the WhatsApp text interaction agent.
 *
 * Responsibilities:
 * - Read the LLM API keys used by text interaction and execution
 * - Read the Supabase service-role config for shared WhatsApp storage
 * - Read the Composio and WhatsApp template config for execution tools
 */

// ============================================================================
// TYPES
// ============================================================================

export interface WhatsAppTextAgentEnv {
  cerebrasApiKey?: string;
  composioApiKey: string;
  openRouterApiKey?: string;
  supabaseServiceRoleKey: string;
  supabaseUrl: string;
  whatsappAccessToken: string;
  whatsappApiVersion: string;
  whatsappPhoneNumberId: string;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

let cachedEnv: WhatsAppTextAgentEnv | null = null;

/**
 * Loads the WhatsApp text-agent environment once.
 * @returns Text-agent environment DTO
 */
export function getWhatsAppTextAgentEnv(): WhatsAppTextAgentEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = {
    cerebrasApiKey: readOptionalEnv("CEREBRAS_API_KEY"),
    composioApiKey: requireEnv("COMPOSIO_API_KEY"),
    openRouterApiKey: readOptionalEnv("OPENROUTER_API_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    whatsappAccessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    whatsappApiVersion: requireEnv("WHATSAPP_API_VERSION"),
    whatsappPhoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
  };

  return cachedEnv;
}

/**
 * Returns the API key for the selected LLM provider.
 * @param provider - Selected provider constant
 * @returns Provider API key
 */
export function getWhatsAppTextLlmApiKey(provider: LlmProvider): string {
  const env = getWhatsAppTextAgentEnv();

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

  throw new Error(`LLM provider "${provider}" is not supported by the WhatsApp text env.`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads one required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required for the WhatsApp text agent`);
  }

  return value;
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
