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

const WHATSAPP_TEMPLATE_LANGUAGE = "en";
const GMAIL_CONNECT_TEMPLATE_NAME = "composio_connect_gmail";
const GOOGLE_CALENDAR_CONNECT_TEMPLATE_NAME = "composio_connect_google_calendar";
const NOTION_CONNECT_TEMPLATE_NAME = "composio_connect_notion";
const OUTLOOK_CONNECT_TEMPLATE_NAME = "composio_connect_outlook";
const CONNECTOR_OVERVIEW_TEMPLATE_NAME = "composio_connector_overview";
const VOICE_SETTINGS_TEMPLATE_NAME = "voice_settings";

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
  return isAuthenticateCommand(messageBody, "authenticate gmail");
}

/**
 * Returns true when an inbound message should trigger Google Calendar authentication.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported Google Calendar auth command
 */
export function isAuthenticateGoogleCalendarCommand(messageBody: string): boolean {
  return isAuthenticateCommand(messageBody, "authenticate google calendar");
}

/**
 * Returns true when an inbound message should trigger Notion authentication.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported Notion auth command
 */
export function isAuthenticateNotionCommand(messageBody: string): boolean {
  return isAuthenticateCommand(messageBody, "authenticate notion");
}

/**
 * Returns true when an inbound message should trigger Outlook authentication.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported Outlook auth command
 */
export function isAuthenticateOutlookCommand(messageBody: string): boolean {
  return isAuthenticateCommand(messageBody, "authenticate outlook");
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
 * Returns true when an inbound message should open the WhatsApp voice settings page.
 * @param messageBody - Raw inbound text message body
 * @returns Whether the message is the supported voice settings command
 */
export function isVoiceSettingsCommand(messageBody: string): boolean {
  return messageBody.trim().toLowerCase() === "voice settings";
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
  return buildWhatsAppConnectorUrl(webBaseUrl, phone, "gmail");
}

/**
 * Builds the Google Calendar connector URL that keeps users inside the /whatsapp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the Google Calendar connector page
 */
export function buildWhatsAppGoogleCalendarConnectorUrl(
  webBaseUrl: string,
  phone: string
): string {
  return buildWhatsAppConnectorUrl(webBaseUrl, phone, "googlecalendar");
}

/**
 * Builds the Notion connector URL that keeps users inside the /whatsapp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the Notion connector page
 */
export function buildWhatsAppNotionConnectorUrl(
  webBaseUrl: string,
  phone: string
): string {
  return buildWhatsAppConnectorUrl(webBaseUrl, phone, "notion");
}

/**
 * Builds the Outlook connector URL that keeps users inside the /whatsapp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the Outlook connector page
 */
export function buildWhatsAppOutlookConnectorUrl(
  webBaseUrl: string,
  phone: string
): string {
  return buildWhatsAppConnectorUrl(webBaseUrl, phone, "outlook");
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
 * Builds the WhatsApp voice settings URL that keeps users inside the auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @returns Full URL to the WhatsApp voice settings page
 */
export function buildWhatsAppVoiceSettingsUrl(
  webBaseUrl: string,
  phone: string
): string {
  const url = new URL("/whatsapp/settings/voice", webBaseUrl);
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
 * Sends the approved WhatsApp Gmail utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppGmailConnectMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    GMAIL_CONNECT_TEMPLATE_NAME,
    phoneUrlVariable
  );
}

/**
 * Sends the approved WhatsApp Google Calendar utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppGoogleCalendarConnectMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    GOOGLE_CALENDAR_CONNECT_TEMPLATE_NAME,
    phoneUrlVariable
  );
}

/**
 * Sends the approved WhatsApp Notion utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppNotionConnectMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    NOTION_CONNECT_TEMPLATE_NAME,
    phoneUrlVariable
  );
}

/**
 * Sends the approved WhatsApp Outlook utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppOutlookConnectMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    OUTLOOK_CONNECT_TEMPLATE_NAME,
    phoneUrlVariable
  );
}

/**
 * Sends the approved WhatsApp connector overview utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppOverviewMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    CONNECTOR_OVERVIEW_TEMPLATE_NAME,
    phoneUrlVariable
  );
}

/**
 * Sends the approved WhatsApp voice settings utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppVoiceSettingsMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  const phoneUrlVariable = buildWhatsAppPhoneUrlVariable(phone);
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    VOICE_SETTINGS_TEMPLATE_NAME,
    phoneUrlVariable
  );
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

/**
 * Sends a WhatsApp utility template with one URL button variable.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @param templateName - Approved WhatsApp template name
 * @param urlVariable - URL variable value passed to the template button
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
async function sendWhatsAppUtilityTemplateMessage(
  config: WhatsAppAuthMessageConfig,
  phone: string,
  templateName: string,
  urlVariable: string
): Promise<void> {
  const endpoint = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone.replace(/[^\d]/g, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
        components: [
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: urlVariable,
              },
            ],
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp template send failed: ${payload}`);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns true when an inbound message matches one auth command.
 * @param messageBody - Raw inbound text message body
 * @param supportedCommand - Supported command in normalized form
 * @returns Whether the incoming text matches the supported command
 */
function isAuthenticateCommand(
  messageBody: string,
  supportedCommand: string
): boolean {
  return messageBody.trim().toLowerCase() === supportedCommand;
}

/**
 * Builds a connector deep link that preserves the WhatsApp auth shell.
 * @param webBaseUrl - Public base URL of the web app
 * @param phone - Normalized WhatsApp phone number
 * @param routeSegment - Connector route segment
 * @returns Full URL to the connector page
 */
function buildWhatsAppConnectorUrl(
  webBaseUrl: string,
  phone: string,
  routeSegment: string
): string {
  const url = new URL(`/whatsapp/connectors/${routeSegment}`, webBaseUrl);
  url.searchParams.set("phone", phone);
  return url.toString();
}

/**
 * Builds the phone query value used by the approved utility templates.
 * @param phone - Normalized WhatsApp phone number
 * @returns URL-safe phone value for the template variable
 */
function buildWhatsAppPhoneUrlVariable(phone: string): string {
  return encodeURIComponent(phone);
}

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
