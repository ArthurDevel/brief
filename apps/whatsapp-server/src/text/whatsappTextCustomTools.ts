/**
 * Composio custom tools for WhatsApp text execution.
 *
 * Responsibilities:
 * - Register WhatsApp auth template tools inside the text execution session
 * - Send approved connector templates to the active WhatsApp user
 * - Keep the supported connector/template mapping in one place
 */

import {
  experimental_createTool,
  type CustomTool,
} from "@composio/core";
import { z } from "zod";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppTextCustomToolConfig {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
}

type SupportedConnectorToolkit = "gmail" | "googlecalendar" | "notion" | "outlook";

// ============================================================================
// CONSTANTS
// ============================================================================

const WHATSAPP_TEMPLATE_LANGUAGE = "en";
const SUPPORTED_CONNECTOR_TOOLKITS = [
  "gmail",
  "googlecalendar",
  "notion",
  "outlook",
] as const;

const CONNECTOR_TEMPLATE_NAMES: Record<SupportedConnectorToolkit, string> = {
  gmail: "composio_connect_gmail",
  googlecalendar: "composio_connect_google_calendar",
  notion: "composio_connect_notion",
  outlook: "composio_connect_outlook",
};

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Creates the WhatsApp auth tools used by the text execution agent.
 * @param config - Graph API config for template sends
 * @param whatsappPhone - Target WhatsApp phone in E.164 format
 * @returns Custom tools registered inside the Composio session
 */
export function createWhatsAppTextCustomTools(
  config: WhatsAppTextCustomToolConfig,
  whatsappPhone: string
): CustomTool[] {
  return [
    experimental_createTool("SEND_WHATSAPP_AUTH_TEMPLATE", {
      name: "Send WhatsApp connector auth template",
      description:
        "Send the user a WhatsApp auth template for Gmail, Google Calendar, Notion, or Outlook when the requested app is not connected yet.",
      inputParams: z.object({
        toolkit: z.enum(SUPPORTED_CONNECTOR_TOOLKITS),
      }),
      execute: async (input) => {
        await sendConnectorTemplate(config, whatsappPhone, input.toolkit);

        return {
          recipientPhone: whatsappPhone,
          toolkit: input.toolkit,
          message: `Sent the WhatsApp ${input.toolkit} connection template.`,
        };
      },
    }),
    experimental_createTool("SEND_WHATSAPP_CONNECTOR_OVERVIEW", {
      name: "Send WhatsApp connector overview template",
      description:
        "Send the user a WhatsApp template that opens the connector overview page.",
      inputParams: z.object({}),
      execute: async () => {
        await sendOverviewTemplate(config, whatsappPhone);

        return {
          recipientPhone: whatsappPhone,
          message: "Sent the WhatsApp connector overview template.",
        };
      },
    }),
  ];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sends one approved connector auth template.
 * @param config - Graph API config
 * @param phone - Target WhatsApp phone number
 * @param toolkit - Supported connector toolkit
 * @returns Promise that resolves when Meta accepts the request
 */
async function sendConnectorTemplate(
  config: WhatsAppTextCustomToolConfig,
  phone: string,
  toolkit: SupportedConnectorToolkit
): Promise<void> {
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    CONNECTOR_TEMPLATE_NAMES[toolkit],
    encodeURIComponent(phone)
  );
}

/**
 * Sends the connector overview template.
 * @param config - Graph API config
 * @param phone - Target WhatsApp phone number
 * @returns Promise that resolves when Meta accepts the request
 */
async function sendOverviewTemplate(
  config: WhatsAppTextCustomToolConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    "composio_connector_overview",
    encodeURIComponent(phone)
  );
}

/**
 * Sends one WhatsApp template with a URL button parameter.
 * @param config - Graph API config
 * @param phone - Target WhatsApp phone number
 * @param templateName - Approved template name
 * @param urlVariable - URL-safe phone variable
 * @returns Promise that resolves when Meta accepts the request
 */
async function sendWhatsAppUtilityTemplateMessage(
  config: WhatsAppTextCustomToolConfig,
  phone: string,
  templateName: string,
  urlVariable: string
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/${normalizeGraphApiVersion(config.apiVersion)}/${config.phoneNumberId}/messages`,
    {
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
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp template send failed: ${payload}`);
  }
}

/**
 * Normalizes the Graph API version into the expected `v23.0` style.
 * @param rawVersion - Raw version from the environment
 * @returns Normalized Graph API version
 */
function normalizeGraphApiVersion(rawVersion: string): string {
  const cleaned = rawVersion.replace(/^v/i, "");
  if (!/^\d+(?:\.0)?$/.test(cleaned)) {
    throw new Error(`WHATSAPP_API_VERSION must look like 23 or v23.0; received "${rawVersion}"`);
  }

  return cleaned.includes(".") ? `v${cleaned}` : `v${cleaned}.0`;
}
