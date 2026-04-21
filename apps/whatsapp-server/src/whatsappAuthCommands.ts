/**
 * WhatsApp auth-command helpers for inbound chat messages.
 *
 * Responsibilities:
 * - Detect supported authenticate commands
 * - Normalize WhatsApp sender numbers to the same E.164 shape used by the web app
 * - Build deep links into the WhatsApp auth shell
 * - Send temporary WhatsApp text messages with those links
 */

import type { WhatsAppTransport } from "./whatsappTransport.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const GMAIL_CONNECT_TEMPLATE_NAME = "composio_connect_gmail";
const GOOGLE_CALENDAR_CONNECT_TEMPLATE_NAME = "composio_connect_google_calendar";
const NOTION_CONNECT_TEMPLATE_NAME = "composio_connect_notion";
const OUTLOOK_CONNECT_TEMPLATE_NAME = "composio_connect_outlook";
const CONNECTOR_OVERVIEW_TEMPLATE_NAME = "composio_connector_overview";
const VOICE_SETTINGS_TEMPLATE_NAME = "voice_settings";

export interface WhatsAppAuthMessageConfig {
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
  const webBaseUrl = requireEnv("WHATSAPP_WEB_BASE_URL");

  return {
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
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    GMAIL_CONNECT_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Connect Gmail: ${buildWhatsAppGmailConnectorUrl(config.webBaseUrl, phone)}`
  );
}

/**
 * Sends the approved WhatsApp Google Calendar utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppGoogleCalendarConnectMessage(
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    GOOGLE_CALENDAR_CONNECT_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Connect Google Calendar: ${buildWhatsAppGoogleCalendarConnectorUrl(config.webBaseUrl, phone)}`
  );
}

/**
 * Sends the approved WhatsApp Notion utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppNotionConnectMessage(
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    NOTION_CONNECT_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Connect Notion: ${buildWhatsAppNotionConnectorUrl(config.webBaseUrl, phone)}`
  );
}

/**
 * Sends the approved WhatsApp Outlook utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppOutlookConnectMessage(
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    OUTLOOK_CONNECT_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Connect Outlook: ${buildWhatsAppOutlookConnectorUrl(config.webBaseUrl, phone)}`
  );
}

/**
 * Sends the approved WhatsApp connector overview utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppOverviewMessage(
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    CONNECTOR_OVERVIEW_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Connected apps overview: ${buildWhatsAppConnectorOverviewUrl(config.webBaseUrl, phone)}`
  );
}

/**
 * Sends the approved WhatsApp voice settings utility template.
 * @param config - WhatsApp config
 * @param phone - Normalized E.164 phone number
 * @returns Promise that resolves when the message is accepted by the Graph API
 */
export async function sendWhatsAppVoiceSettingsMessage(
  transport: WhatsAppTransport,
  config: WhatsAppAuthMessageConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppAuthLinkMessage(
    transport,
    phone,
    VOICE_SETTINGS_TEMPLATE_NAME,
    buildWhatsAppPhoneUrlVariable(phone),
    `Voice settings: ${buildWhatsAppVoiceSettingsUrl(config.webBaseUrl, phone)}`
  );
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
 * Sends one auth-link template through the active transport.
 * @param transport - Active WhatsApp transport
 * @param phone - Normalized phone number
 * @param templateName - Approved template name
 * @param urlVariable - URL template variable
 * @param fallbackText - Emulator-safe fallback text
 * @returns Promise that resolves when the message is accepted
 */
async function sendWhatsAppAuthLinkMessage(
  transport: WhatsAppTransport,
  phone: string,
  templateName: string,
  urlVariable: string,
  fallbackText: string
): Promise<void> {
  await transport.sendTemplateMessage({
    fallbackText,
    templateName,
    to: phone,
    urlVariable
  });
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
