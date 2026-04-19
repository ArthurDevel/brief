export interface WhatsAppMessagingConfig {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
}

const AUTH_TEMPLATE_NAME = "otp_code";
const AUTH_TEMPLATE_LANGUAGE = "en";

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

function toWhatsAppRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

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

export async function sendWhatsAppAuthTemplate(
  config: WhatsAppMessagingConfig,
  phone: string,
  code: string
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
      to: toWhatsAppRecipient(phone),
      type: "template",
      template: {
        name: AUTH_TEMPLATE_NAME,
        language: { code: AUTH_TEMPLATE_LANGUAGE },
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
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp template send failed: ${payload}`);
  }
}
