/**
 * WhatsApp transport boundary for real and emulator-backed delivery.
 *
 * Responsibilities:
 * - Hide provider-specific send APIs behind one small interface
 * - Select the real Meta transport or the local emulator transport from env
 * - Keep transport-specific behavior out of the bot logic
 */

import { WhatsApp } from "meta-cloud-api";

// ============================================================================
// TYPES
// ============================================================================

export interface SendWhatsAppTextMessageParams {
  body: string;
  replyMessageId?: string;
  to: string;
}

export interface SendWhatsAppTemplateMessageParams {
  fallbackText: string;
  templateName: string;
  to: string;
  urlVariable: string;
}

export interface SendWhatsAppTypingIndicatorParams {
  messageId: string;
  to: string;
}

export interface GetWhatsAppMediaByIdResult {
  mime_type: string;
  url: string;
}

export interface WhatsAppCallSessionParams {
  sdp: string;
  sdp_type: "answer";
}

export interface WhatsAppTransport {
  readonly mode: "emulator" | "meta";
  acceptCall(callId: string, session: WhatsAppCallSessionParams, opaqueCallbackData: string): Promise<void>;
  getMediaById(mediaId: string): Promise<GetWhatsAppMediaByIdResult>;
  preAcceptCall(callId: string, session: WhatsAppCallSessionParams): Promise<void>;
  rejectCall(callId: string): Promise<void>;
  sendTemplateMessage(params: SendWhatsAppTemplateMessageParams): Promise<void>;
  sendTextMessage(params: SendWhatsAppTextMessageParams): Promise<void>;
  sendTypingIndicator(params: SendWhatsAppTypingIndicatorParams): Promise<void>;
}

export interface LegacyWhatsAppClient {
  messages: {
    text(params: SendWhatsAppTextMessageParams): Promise<unknown>;
  };
  media: {
    getMediaById(mediaId: string): Promise<GetWhatsAppMediaByIdResult>;
  };
  calling: {
    acceptCall(params: {
      biz_opaque_callback_data: string;
      call_id: string;
      session: WhatsAppCallSessionParams;
    }): Promise<unknown>;
    preAcceptCall(params: {
      call_id: string;
      session: WhatsAppCallSessionParams;
    }): Promise<unknown>;
    rejectCall(params: { call_id: string }): Promise<unknown>;
  };
}

interface CreateWhatsAppTransportDependencies {
  client?: LegacyWhatsAppClient;
  fetchImplementation?: typeof fetch;
}

interface MetaTransportEnv {
  accessToken: string;
  apiVersion: string;
  businessAcctId: string;
  phoneNumberId: number;
}

interface EmulatorTransportEnv {
  emulatorBaseUrl: string;
}

type TransportMode = "emulator" | "meta";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_API_VERSION = "23";
const DEFAULT_TRANSPORT_MODE: TransportMode = "meta";
const TEMPLATE_LANGUAGE = "en";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Creates the active WhatsApp transport from dependencies and env.
 * @param dependencies - Optional injected client/fetch for tests
 * @returns Selected transport implementation
 */
export function createWhatsAppTransport(
  dependencies: CreateWhatsAppTransportDependencies = {}
): WhatsAppTransport {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const transportMode = getTransportMode();

  if (transportMode === "emulator") {
    return new EmulatorWhatsAppTransport(fetchImplementation, getEmulatorTransportEnv());
  }

  return new MetaWhatsAppTransport(
    dependencies.client ?? createMetaClient(),
    fetchImplementation,
    getMetaTransportEnv()
  );
}

/**
 * Returns the configured transport mode.
 * @returns Transport mode
 */
export function getTransportMode(): TransportMode {
  const rawMode = process.env.WHATSAPP_TRANSPORT_MODE?.trim().toLowerCase() || DEFAULT_TRANSPORT_MODE;
  if (rawMode !== "meta" && rawMode !== "emulator") {
    throw new Error(`WHATSAPP_TRANSPORT_MODE must be "meta" or "emulator". Received "${rawMode}".`);
  }

  return rawMode;
}

// ============================================================================
// TRANSPORT IMPLEMENTATIONS
// ============================================================================

class MetaWhatsAppTransport implements WhatsAppTransport {
  readonly mode = "meta" as const;

  private readonly client: LegacyWhatsAppClient;
  private readonly fetchImplementation: typeof fetch;
  private readonly env: MetaTransportEnv;

  /**
   * Creates the real Meta-backed transport.
   * @param client - WhatsApp SDK client
   * @param fetchImplementation - Fetch implementation for direct Graph requests
   * @param env - Meta transport environment
   */
  constructor(
    client: LegacyWhatsAppClient,
    fetchImplementation: typeof fetch,
    env: MetaTransportEnv
  ) {
    this.client = client;
    this.fetchImplementation = fetchImplementation;
    this.env = env;
  }

  /**
   * Sends a plain WhatsApp text message.
   * @param params - Text message params
   * @returns Promise that resolves when accepted
   */
  async sendTextMessage(params: SendWhatsAppTextMessageParams): Promise<void> {
    await this.client.messages.text(params);
  }

  /**
   * Sends a WhatsApp utility template.
   * @param params - Template params with emulator fallback text
   * @returns Promise that resolves when accepted
   */
  async sendTemplateMessage(params: SendWhatsAppTemplateMessageParams): Promise<void> {
    const response = await this.fetchImplementation(this.getMessagesEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.to.replace(/[^\d]/g, ""),
        type: "template",
        template: {
          name: params.templateName,
          language: { code: TEMPLATE_LANGUAGE },
          components: [
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [
                {
                  type: "text",
                  text: params.urlVariable
                }
              ]
            }
          ]
        }
      })
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`WhatsApp template send failed: ${responseText}`);
    }
  }

  /**
   * Sends the WhatsApp read/typing indicator update.
   * @param params - Typing indicator params
   * @returns Promise that resolves when accepted
   */
  async sendTypingIndicator(params: SendWhatsAppTypingIndicatorParams): Promise<void> {
    const response = await this.fetchImplementation(this.getMessagesEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: params.messageId,
        typing_indicator: {
          type: "text"
        }
      })
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`WhatsApp typing indicator failed: ${responseText}`);
    }
  }

  /**
   * Looks up one WhatsApp media object.
   * @param mediaId - WhatsApp media ID
   * @returns Media lookup result
   */
  async getMediaById(mediaId: string): Promise<GetWhatsAppMediaByIdResult> {
    return await this.client.media.getMediaById(mediaId);
  }

  /**
   * Sends the Meta pre-accept call request.
   * @param callId - WhatsApp call ID
   * @param session - SDP answer session
   * @returns Promise that resolves when accepted
   */
  async preAcceptCall(callId: string, session: WhatsAppCallSessionParams): Promise<void> {
    await this.client.calling.preAcceptCall({
      call_id: callId,
      session
    });
  }

  /**
   * Sends the Meta accept call request.
   * @param callId - WhatsApp call ID
   * @param session - SDP answer session
   * @param opaqueCallbackData - Callback data string
   * @returns Promise that resolves when accepted
   */
  async acceptCall(
    callId: string,
    session: WhatsAppCallSessionParams,
    opaqueCallbackData: string
  ): Promise<void> {
    await this.client.calling.acceptCall({
      call_id: callId,
      session,
      biz_opaque_callback_data: opaqueCallbackData
    });
  }

  /**
   * Rejects a WhatsApp call.
   * @param callId - WhatsApp call ID
   * @returns Promise that resolves when accepted
   */
  async rejectCall(callId: string): Promise<void> {
    await this.client.calling.rejectCall({ call_id: callId });
  }

  /**
   * Builds the Meta Graph messages endpoint.
   * @returns Graph messages endpoint URL
   */
  private getMessagesEndpoint(): string {
    return `https://graph.facebook.com/v${this.env.apiVersion}.0/${this.env.phoneNumberId}/messages`;
  }
}

class EmulatorWhatsAppTransport implements WhatsAppTransport {
  readonly mode = "emulator" as const;

  private readonly fetchImplementation: typeof fetch;
  private readonly env: EmulatorTransportEnv;

  /**
   * Creates the local emulator-backed transport.
   * @param fetchImplementation - Fetch implementation
   * @param env - Emulator transport environment
   */
  constructor(fetchImplementation: typeof fetch, env: EmulatorTransportEnv) {
    this.fetchImplementation = fetchImplementation;
    this.env = env;
  }

  /**
   * Delivers plain text to the emulator inbox.
   * @param params - Text message params
   * @returns Promise that resolves when stored
   */
  async sendTextMessage(params: SendWhatsAppTextMessageParams): Promise<void> {
    await this.postJson("/api/emulator/outbound/text", params);
  }

  /**
   * Delivers the emulator fallback text for a template message.
   * @param params - Template params
   * @returns Promise that resolves when stored
   */
  async sendTemplateMessage(params: SendWhatsAppTemplateMessageParams): Promise<void> {
    await this.postJson("/api/emulator/outbound/text", {
      body: params.fallbackText,
      to: params.to
    });
  }

  /**
   * Stores a typing indicator for the emulator UI.
   * @param params - Typing indicator params
   * @returns Promise that resolves when stored
   */
  async sendTypingIndicator(params: SendWhatsAppTypingIndicatorParams): Promise<void> {
    await this.postJson("/api/emulator/outbound/typing", params);
  }

  /**
   * Media lookup is not implemented for the emulator transport yet.
   * @param mediaId - WhatsApp media ID
   * @returns Never resolves successfully
   */
  async getMediaById(mediaId: string): Promise<GetWhatsAppMediaByIdResult> {
    throw new Error(`Emulator media lookup is not implemented for media ID "${mediaId}".`);
  }

  /**
   * Call pre-accept is not implemented for the emulator transport.
   * @param callId - WhatsApp call ID
   * @param session - SDP answer session
   * @returns Never resolves successfully
   */
  async preAcceptCall(callId: string, session: WhatsAppCallSessionParams): Promise<void> {
    void session;
    throw new Error(`Emulator call pre-accept is not implemented for call "${callId}".`);
  }

  /**
   * Call accept is not implemented for the emulator transport.
   * @param callId - WhatsApp call ID
   * @param session - SDP answer session
   * @param opaqueCallbackData - Callback data string
   * @returns Never resolves successfully
   */
  async acceptCall(
    callId: string,
    session: WhatsAppCallSessionParams,
    opaqueCallbackData: string
  ): Promise<void> {
    void session;
    void opaqueCallbackData;
    throw new Error(`Emulator call accept is not implemented for call "${callId}".`);
  }

  /**
   * Call reject is not implemented for the emulator transport.
   * @param callId - WhatsApp call ID
   * @returns Never resolves successfully
   */
  async rejectCall(callId: string): Promise<void> {
    throw new Error(`Emulator call reject is not implemented for call "${callId}".`);
  }

  /**
   * Posts JSON to the emulator API.
   * @param path - Emulator API path
   * @param payload - Request payload
   * @returns Promise that resolves when accepted
   */
  private async postJson(path: string, payload: unknown): Promise<void> {
    const response = await this.fetchImplementation(new URL(path, this.env.emulatorBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`Emulator transport request failed (${response.status}): ${responseText}`);
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Builds the default Meta WhatsApp SDK client.
 * @returns Configured SDK client
 */
function createMetaClient(): WhatsApp {
  const env = getMetaTransportEnv();
  return new WhatsApp({
    accessToken: env.accessToken,
    phoneNumberId: env.phoneNumberId,
    businessAcctId: env.businessAcctId,
    apiVersion: env.apiVersion
  });
}

/**
 * Reads the Meta transport environment.
 * @returns Meta transport env
 */
function getMetaTransportEnv(): MetaTransportEnv {
  const phoneNumberId = Number.parseInt(requireEnv("WHATSAPP_PHONE_NUMBER_ID"), 10);
  if (!Number.isFinite(phoneNumberId)) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID must be a valid integer.");
  }

  return {
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    apiVersion: normalizeApiVersion(process.env.WHATSAPP_API_VERSION?.trim() || DEFAULT_API_VERSION),
    businessAcctId: requireEnv("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    phoneNumberId
  };
}

/**
 * Reads the emulator transport environment.
 * @returns Emulator transport env
 */
function getEmulatorTransportEnv(): EmulatorTransportEnv {
  return {
    emulatorBaseUrl: requireEnv("WHATSAPP_EMULATOR_URL")
  };
}

/**
 * Reads a required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }

  return value;
}

/**
 * Normalizes the Graph API version to the SDK-friendly shape.
 * @param rawVersion - Raw API version
 * @returns Normalized API version without the leading `v`
 */
function normalizeApiVersion(rawVersion: string): string {
  const normalized = rawVersion.trim().replace(/^v/i, "").replace(/\.0$/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `WHATSAPP_API_VERSION must look like 23, 23.0, or v23.0. Received "${rawVersion}".`
    );
  }

  return normalized;
}
