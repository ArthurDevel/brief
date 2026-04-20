/**
 * Composio custom tools for WhatsApp-specific authentication flows.
 *
 * Responsibilities:
 * - Register standalone custom tools inside the Composio session
 * - Send approved WhatsApp connector templates to the active caller
 * - Keep the supported connector slugs and template names in one place
 */

import {
  experimental_createTool,
  type CustomTool,
} from "@composio/core";
import { z } from "zod";
import type { AgentEnv } from "./env.js";
import type { WhatsAppCallerContext } from "./whatsappRuntime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_WHATSAPP_API_VERSION = "23";
const WHATSAPP_TEMPLATE_LANGUAGE = "en";
const AUTH_TEMPLATE_TOOL_SLUG = "SEND_WHATSAPP_AUTH_TEMPLATE";
const OVERVIEW_TEMPLATE_TOOL_SLUG = "SEND_WHATSAPP_CONNECTOR_OVERVIEW";
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
// TYPES
// ============================================================================

type SupportedConnectorToolkit = (typeof SUPPORTED_CONNECTOR_TOOLKITS)[number];

interface WhatsAppTemplateConfig {
  accessToken: string;
  apiVersion: string;
  phoneNumberId: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Creates the standalone custom tools that help callers connect apps through WhatsApp.
 * @param env - Agent environment config
 * @param callerContext - Caller identity and connected-account context
 * @returns Custom tools to register inside the Composio session
 */
export function createWhatsAppCustomTools(
  env: AgentEnv,
  callerContext: WhatsAppCallerContext
): CustomTool[] {
  return [
    experimental_createTool(AUTH_TEMPLATE_TOOL_SLUG, {
      name: "Send WhatsApp connector auth template",
      description:
        "Send the caller a WhatsApp template that opens the connector flow for Gmail, Google Calendar, Notion, or Outlook. Use this when the caller asks to connect one of those apps or when the requested app is not connected yet.",
      inputParams: z.object({
        toolkit: z.enum(SUPPORTED_CONNECTOR_TOOLKITS).describe(
          "The app the caller wants to connect: gmail, googlecalendar, notion, or outlook."
        ),
      }),
      execute: async (input) => {
        const config = getWhatsAppTemplateConfig(env);
        await sendConnectorTemplate(config, callerContext.callerPhone, input.toolkit);

        return {
          message: `Sent the WhatsApp ${input.toolkit} connection template to the caller.`,
          recipientPhone: callerContext.callerPhone,
          toolkit: input.toolkit,
        };
      },
    }),
    experimental_createTool(OVERVIEW_TEMPLATE_TOOL_SLUG, {
      name: "Send WhatsApp connector overview template",
      description:
        "Send the caller a WhatsApp template that opens the connector overview page. Use this when the caller wants to review or reconnect their available app connections.",
      inputParams: z.object({}),
      execute: async () => {
        const config = getWhatsAppTemplateConfig(env);
        await sendOverviewTemplate(config, callerContext.callerPhone);

        return {
          message: "Sent the WhatsApp connector overview template to the caller.",
          recipientPhone: callerContext.callerPhone,
        };
      },
    }),
  ];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads the WhatsApp Graph API configuration required for template sends.
 * @param env - Agent environment config
 * @returns Graph API config for template sends
 */
function getWhatsAppTemplateConfig(env: AgentEnv): WhatsAppTemplateConfig {
  return {
    accessToken: env.whatsappAccessToken,
    apiVersion: normalizeGraphApiVersion(env.whatsappApiVersion),
    phoneNumberId: env.whatsappPhoneNumberId,
  };
}

/**
 * Sends one approved connector auth template.
 * @param config - Graph API config
 * @param phone - Caller phone number in E.164 format
 * @param toolkit - Supported connector toolkit
 * @returns Promise that resolves when Meta accepts the message
 */
async function sendConnectorTemplate(
  config: WhatsAppTemplateConfig,
  phone: string,
  toolkit: SupportedConnectorToolkit
): Promise<void> {
  const templateName = CONNECTOR_TEMPLATE_NAMES[toolkit];
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    templateName,
    buildWhatsAppPhoneUrlVariable(phone)
  );
}

/**
 * Sends the approved connector overview template.
 * @param config - Graph API config
 * @param phone - Caller phone number in E.164 format
 * @returns Promise that resolves when Meta accepts the message
 */
async function sendOverviewTemplate(
  config: WhatsAppTemplateConfig,
  phone: string
): Promise<void> {
  await sendWhatsAppUtilityTemplateMessage(
    config,
    phone,
    "composio_connector_overview",
    buildWhatsAppPhoneUrlVariable(phone)
  );
}

/**
 * Sends a WhatsApp utility template with one URL button parameter.
 * @param config - Graph API config
 * @param phone - Caller phone number in E.164 format
 * @param templateName - Approved template name
 * @param urlVariable - URL-safe phone variable used by the template button
 * @returns Promise that resolves when Meta accepts the message
 */
async function sendWhatsAppUtilityTemplateMessage(
  config: WhatsAppTemplateConfig,
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
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`WhatsApp template send failed: ${payload}`);
  }
}

/**
 * Builds the URL-safe phone variable required by the approved WhatsApp templates.
 * @param phone - Caller phone number in E.164 format
 * @returns Encoded phone string
 */
function buildWhatsAppPhoneUrlVariable(phone: string): string {
  return encodeURIComponent(phone);
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

/**
 * Returns the default API version when the environment does not override it.
 * @returns Default WhatsApp Graph API version
 */
export function getDefaultWhatsAppApiVersion(): string {
  return DEFAULT_WHATSAPP_API_VERSION;
}
