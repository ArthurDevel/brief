/**
 * Environment loading for the WhatsApp emulator.
 *
 * Responsibilities:
 * - Read and validate the emulator runtime environment
 * - Expose a typed config object for the server and services
 */

// ============================================================================
// TYPES
// ============================================================================

export interface EmulatorEnv {
  livekitAgentName: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitUrl: string;
  port: number;
  supabaseServiceRoleKey: string;
  supabaseUrl: string;
  whatsappServerUrl: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PORT = 3030;

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Returns the validated emulator environment.
 * @returns Validated environment config
 */
export function getEnv(): EmulatorEnv {
  return {
    livekitAgentName: process.env.LIVEKIT_AGENT_NAME?.trim() || "whatsapp-composio-agent",
    livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
    livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),
    livekitUrl: requireEnv("LIVEKIT_URL"),
    port: getPort(),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseUrl: requireEnv("SUPABASE_URL"),
    whatsappServerUrl: requireEnv("WHATSAPP_SERVER_URL")
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns a required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }

  return value;
}

/**
 * Parses the emulator port.
 * @returns Numeric port value
 */
function getPort(): number {
  const rawPort = process.env.PORT?.trim() || String(DEFAULT_PORT);
  const port = Number.parseInt(rawPort, 10);

  if (Number.isNaN(port)) {
    throw new Error(`PORT must be a valid integer. Received "${rawPort}".`);
  }

  return port;
}
