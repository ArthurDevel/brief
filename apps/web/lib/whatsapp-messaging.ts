export interface WhatsAppMessagingConfig {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
}

export interface WhatsAppTemplateSendResult {
  phoneNumberId: string;
  recipient: string;
  templateName: string;
  responseBody: unknown;
}

const AUTH_TEMPLATE_NAME = "otp_code";
const AUTH_TEMPLATE_LANGUAGE = "en";
const SESSION_SUMMARY_TEMPLATE_NAME = "session_summary";

/**
 * Reads the WhatsApp Graph API configuration used for template sends.
 * @returns Config with sender phone number ID and Graph API settings
 */
export function getWhatsAppMessagingConfig(): WhatsAppMessagingConfig {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v23.0";

  if (!accessToken || !phoneNumberId) {
    throw new Error("Missing WhatsApp Graph API configuration.");
  }

  return {
    accessToken,
    apiVersion,
    phoneNumberId,
  };
}

/**
 * Converts a phone number to the digit-only format expected by WhatsApp.
 * @param phone - User phone number in any supported format
 * @returns Recipient phone number with non-digit characters removed
 */
function toWhatsAppRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Parses a Graph API response body as JSON when possible.
 * @param response - Fetch response from Graph API
 * @returns Parsed JSON body or raw text when the payload is not JSON
 */
async function parseGraphResponseBody(response: Response): Promise<unknown> {
  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

/**
 * Sends a WhatsApp template message and returns the Graph API response details.
 * @param config - Graph API sender configuration
 * @param phone - Recipient phone number
 * @param template - Template name, language, and components
 * @returns Graph API send result with sender, recipient, and response payload
 */
async function sendWhatsAppTemplateMessage(
  config: WhatsAppMessagingConfig,
  phone: string,
  template: {
    name: string;
    language: string;
    components: Array<Record<string, unknown>>;
  }
): Promise<WhatsAppTemplateSendResult> {
  const recipient = toWhatsAppRecipient(phone);
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
      to: recipient,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.components,
      },
    }),
    cache: "no-store",
  });

  const responseBody = await parseGraphResponseBody(response);

  if (!response.ok) {
    throw new Error(`WhatsApp template send failed: ${JSON.stringify(responseBody)}`);
  }

  return {
    phoneNumberId: config.phoneNumberId,
    recipient,
    templateName: template.name,
    responseBody,
  };
}

/**
 * Sends a plain WhatsApp text message.
 * @param config - Graph API sender configuration
 * @param phone - Recipient phone number
 * @param text - Message body to send
 * @returns Resolves when the Graph API accepts the request
 */
export async function sendWhatsAppText(
  config: WhatsAppMessagingConfig,
  phone: string,
  text: string
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
      to: toWhatsAppRecipient(phone),
      type: "text",
      text: {
        body: text,
        preview_url: false,
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp send failed: ${payload}`);
  }
}

/**
 * Sends the OTP authentication template to a WhatsApp user.
 * @param config - Graph API sender configuration
 * @param phone - Recipient phone number
 * @param code - One-time verification code
 * @returns Graph API send result for logging and traceability
 */
export async function sendWhatsAppAuthTemplate(
  config: WhatsAppMessagingConfig,
  phone: string,
  code: string
): Promise<WhatsAppTemplateSendResult> {
  return sendWhatsAppTemplateMessage(config, phone, {
    name: AUTH_TEMPLATE_NAME,
    language: AUTH_TEMPLATE_LANGUAGE,
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: code },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [
          { type: "text", text: code },
        ],
      },
    ],
  });
}

/**
 * Sends the post-call session link template to a WhatsApp user.
 * @param config - Graph API sender configuration
 * @param phone - Recipient phone number
 * @param sessionId - Session ID inserted into the template URL
 * @returns Resolves when the Graph API accepts the request
 */
export async function sendWhatsAppSessionLinkTemplate(
  config: WhatsAppMessagingConfig,
  phone: string,
  sessionId: string
): Promise<void> {
  await sendWhatsAppTemplateMessage(config, phone, {
    name: SESSION_SUMMARY_TEMPLATE_NAME,
    language: AUTH_TEMPLATE_LANGUAGE,
    components: [
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [
          { type: "text", text: sessionId },
        ],
      },
    ],
  });
}
