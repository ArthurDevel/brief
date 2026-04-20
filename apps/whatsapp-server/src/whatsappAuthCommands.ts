/**
 * WhatsApp auth-command helpers for inbound chat messages.
 *
 * Responsibilities:
 * - Detect supported authenticate commands
 * - Normalize WhatsApp sender numbers to the same E.164 shape used by the web app
 * - Build deep links into the WhatsApp auth shell
 * - Send temporary WhatsApp text messages with those links
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export interface WhatsAppAuthMessageConfig {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
  webBaseUrl: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns true when an inbound message should trigger Gmail authentication.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported Gmail auth command
 */
export function isAuthenticateGmailCommand(messageBody: string): boolean {
  return messageBody.trim().toLowerCase() === "authenticate gmail";
}

/**
 * Returns true when an inbound message should open the connectors overview page.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported overview command
 */
export function isAuthenticateOverviewCommand(messageBody: string): boolean {
  return messageBody.trim().toLowerCase() === "authenticate overview";
}

/**
 * Normalizes a WhatsApp caller number into E.164 format.
 * @param rawPhone - Raw WhatsApp sender or caller phone value
 * @returns E.164 phone number, or null when invalid
 */
export function normalizeWhatsAppCallerPhone(rawPhone: string | undefined): string | null {
  const trimmed = rawPhone?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  if (digitsOnly.length < 8 || digitsOnly.length > 15) {
    return null;
  }

  return `+${digitsOnly}`;
}

/**
 * Builds the Gmail connector URL that keeps users inside the /whatsapp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the Gmail connector page
 */
export function buildWhatsAppGmailConnectorUrl(
  webBaseUrl: string,
  phone: string
): string {
  const url = new URL("/whatsapp/connectors/gmail", webBaseUrl);
  url.searchParams.set("phone", phone);
  return url.toString();
}

/**
 * Builds the connector overview URL that keeps users inside the /whatsapp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the connector overview page
 */
export function buildWhatsAppConnectorOverviewUrl(
  webBaseUrl: string,
  phone: string
): string {
  const url = new URL("/whatsapp/connectors/overview", webBaseUrl);
  url.searchParams.set("phone", phone);
  return url.toString();
}

/**
 * Loads the WhatsApp configuration required to send auth-link messages.
 * @returns Config for the WhatsApp Graph API
 */
export function getWhatsAppAuthMessageConfig(): WhatsAppAuthMessageConfig {
  const accessToken = requireEnv("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
  const webBaseUrl = requireEnv("WHATSAPP_WEB_BASE_URL");
  const apiVersion = normalizeGraphApiVersion(process.env.WHATSAPP_API_VERSION?.trim() || "23");

  return {
    accessToken,
    apiVersion,
    phoneNumberId,
    webBaseUrl,
  };
}

/**
 * Sends a temporary plain-text WhatsApp message with the Gmail connector URL.
 * The template version is intentionally commented out until WhatsApp approves it.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppGmailConnectMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const connectUrl = buildWhatsAppGmailConnectorUrl(config.webBaseUrl, phone);
  await sendWhatsAppTextMessage(config, phone, `Open this link to connect Gmail: ${connectUrl}`);
}

/**
 * Sends a temporary plain-text WhatsApp message with the connectors overview URL.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppOverviewMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const overviewUrl = buildWhatsAppConnectorOverviewUrl(config.webBaseUrl, phone);
  await sendWhatsAppTextMessage(config, phone, `Open this link to view your connectors: ${overviewUrl}`);
}

/**
 * Sends a simple WhatsApp text message.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @param body - Text message body
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
async function sendWhatsAppTextMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string,
  body: string
): Promise<void> {
  const endpoint = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Temporary fallback while the CTA template is still under review.
      // type: "template",
      // template: {
      //   name: "composio_connect_gmail",
      //   language: { code: "en" },
      //   components: [
      //     {
      //       type: "button",
      //       sub_type: "url",
      //       index: "0",
      //       parameters: [
      //         {
      //           type: "text",
      //           text: connectUrl,
      //         },
      //       ],
      //     },
      //   ],
      // },
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone.replace(/[^\d]/g, ""),
      type: "text",
      text: {
        body,
        preview_url: false,
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp Gmail message send failed: ${payload}`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads a required environment variable.
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
 * Normalizes WhatsApp Graph API versions to the expected `v23.0` shape.
 * @param rawVersion - Raw version from the environment
 * @returns Normalized version string for Graph API requests
 */
function normalizeGraphApiVersion(rawVersion: string): string {
  const cleaned = rawVersion.replace(/^v/i, "");
  if (!/^\d+(?:\.0)?$/.test(cleaned)) {
    throw new Error(`WHATSAPP_API_VERSION must look like 23 or v23.0; received "${rawVersion}"`);
  }

  return cleaned.includes(".") ? `v${cleaned}` : `v${cleaned}.0`;
}
