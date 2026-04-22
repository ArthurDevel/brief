/**
 * Environment loader for the WhatsApp text interaction agent.
 *
 * Responsibilities:
 * - Read the OpenRouter configuration for text interaction and execution
 * - Read the Supabase service-role config for shared WhatsApp storage
 * - Read the Composio and WhatsApp template config for execution tools
 */

// ============================================================================
// TYPES
// ============================================================================

export interface WhatsAppTextAgentEnv {
  composioApiKey: string;
  openRouterApiKey: string;
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
    composioApiKey: requireEnv("COMPOSIO_API_KEY"),
    openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    whatsappAccessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    whatsappApiVersion: requireEnv("WHATSAPP_API_VERSION"),
    whatsappPhoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
  };

  return cachedEnv;
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
