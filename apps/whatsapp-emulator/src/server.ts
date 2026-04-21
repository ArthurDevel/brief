/**
 * Dev-only WhatsApp emulator server.
 *
 * Responsibilities:
 * - Serve the browser emulator UI
 * - Create browser-based LiveKit calls for local voice testing
 * - Forward inbound text messages to the existing WhatsApp webhook endpoint
 * - Store outbound emulator messages and typing state for the UI
 */

import { config as loadDotEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { getEnv } from "./lib/env.js";
import { EmulatorLiveKitRoomManager } from "./lib/livekitRoomManager.js";
import { SupabaseCallerLookup } from "./lib/supabaseCallerLookup.js";
import type {
  ApiErrorResponseDto,
  EmulatorChatMessageDto,
  EndCallRequestDto,
  ListEmulatorMessagesResponseDto,
  SendEmulatorTextMessageRequestDto,
  StartCallRequestDto,
  StoreOutboundTextMessageRequestDto,
  StoreTypingIndicatorRequestDto
} from "./lib/types.js";

// ============================================================================
// TYPES
// ============================================================================

interface InboundTextWebhookBody {
  entry: Array<{
    changes: Array<{
      field: "messages";
      value: {
        messages: Array<{
          from: string;
          id: string;
          text: {
            body: string;
          };
          type: "text";
        }>;
      };
    }>;
  }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const uiDirectory = path.resolve(currentDir, "../src/ui");
const livekitClientBundlePath = require.resolve("livekit-client");
const livekitClientDistDirectory = path.dirname(livekitClientBundlePath);
const MAX_STORED_MESSAGES = 200;
const TYPING_INDICATOR_MS = 5000;

loadDotEnv({ path: path.resolve(currentDir, "../.env") });

const env = getEnv();
const app = express();
const roomManager = new EmulatorLiveKitRoomManager(env);
const callerLookup = new SupabaseCallerLookup(env);
const messagesByPhone = new Map<string, EmulatorChatMessageDto[]>();
const typingIndicatorUntilByPhone = new Map<string, number>();

app.use(express.json({ limit: "2mb" }));
app.use("/vendor/livekit-client", express.static(livekitClientDistDirectory));
app.use(express.static(uiDirectory));

// ============================================================================
// MAIN ENDPOINTS
// ============================================================================

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/dev-call/start", async (req, res) => {
  try {
    const body = req.body as Partial<StartCallRequestDto> | null;
    const callerPhone = body?.callerPhone?.trim() ?? "";

    if (!callerPhone) {
      sendApiError(res, 400, "CALLER_PHONE_REQUIRED", "Enter a caller phone number.");
      return;
    }

    const knownCaller = await requireKnownCallerOrSendError(res, callerPhone);
    if (!knownCaller) {
      return;
    }

    const session = await roomManager.startCall(knownCaller.phone);
    console.info("[whatsapp-emulator] started call", {
      callId: session.callId,
      callerPhone: knownCaller.phone,
      roomName: session.roomName,
      userId: knownCaller.userId
    });

    res.status(200).json(session);
  } catch (error) {
    console.error("[whatsapp-emulator] failed to start call", error);
    sendApiError(res, 500, "START_CALL_FAILED", "Unable to start the emulator call.");
  }
});

app.post("/api/dev-call/end", async (req, res) => {
  try {
    const body = req.body as Partial<EndCallRequestDto> | null;
    const roomName = body?.roomName?.trim() ?? "";

    if (!roomName) {
      sendApiError(res, 400, "ROOM_NAME_REQUIRED", "Room name is required.");
      return;
    }

    await roomManager.endCall(roomName);
    console.info("[whatsapp-emulator] ended call", {
      roomName
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[whatsapp-emulator] failed to end call", error);
    sendApiError(res, 500, "END_CALL_FAILED", "Unable to end the emulator call.");
  }
});

app.get("/api/emulator/chat/messages", (req, res) => {
  const phone = getPhoneFromQuery(req.query.phone);
  if (!phone) {
    sendApiError(res, 400, "PHONE_REQUIRED", "Enter a caller phone number.");
    return;
  }

  res.status(200).json({
    isTyping: getIsTyping(phone),
    messages: messagesByPhone.get(phone) ?? []
  } satisfies ListEmulatorMessagesResponseDto);
});

app.post("/api/emulator/chat/send", async (req, res) => {
  try {
    const body = req.body as Partial<SendEmulatorTextMessageRequestDto> | null;
    const from = body?.from?.trim() ?? "";
    const messageBody = body?.body?.trim() ?? "";

    if (!from) {
      sendApiError(res, 400, "CALLER_PHONE_REQUIRED", "Enter a caller phone number.");
      return;
    }

    if (!messageBody) {
      sendApiError(res, 400, "MESSAGE_BODY_REQUIRED", "Enter a message before sending.");
      return;
    }

    const knownCaller = await requireKnownCallerOrSendError(res, from);
    if (!knownCaller) {
      return;
    }

    const messageId = `emulator-${randomUUID()}`;
    storeMessage(knownCaller.phone, "inbound", messageBody, messageId);
    clearTypingIndicator(knownCaller.phone);

    await forwardInboundTextWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    from: knownCaller.phone.replace(/[^\d]/g, ""),
                    id: messageId,
                    text: {
                      body: messageBody
                    },
                    type: "text"
                  }
                ]
              }
            }
          ]
        }
      ]
    });

    res.status(200).json({
      isTyping: getIsTyping(knownCaller.phone),
      messages: messagesByPhone.get(knownCaller.phone) ?? []
    } satisfies ListEmulatorMessagesResponseDto);
  } catch (error) {
    console.error("[whatsapp-emulator] failed to send inbound emulator text", error);
    sendApiError(res, 500, "SEND_MESSAGE_FAILED", "Unable to send the emulator message.");
  }
});

app.post("/api/emulator/outbound/text", (req, res) => {
  const body = req.body as Partial<StoreOutboundTextMessageRequestDto> | null;
  const to = body?.to?.trim() ?? "";
  const messageBody = body?.body?.trim() ?? "";

  if (!to || !messageBody) {
    sendApiError(res, 400, "INVALID_OUTBOUND_MESSAGE", "Outbound message payload is invalid.");
    return;
  }

  storeMessage(to, "outbound", messageBody, randomUUID());
  clearTypingIndicator(to);
  res.status(200).json({ ok: true });
});

app.post("/api/emulator/outbound/typing", (req, res) => {
  const body = req.body as Partial<StoreTypingIndicatorRequestDto> | null;
  const to = body?.to?.trim() ?? "";

  if (!to) {
    sendApiError(res, 400, "INVALID_TYPING_EVENT", "Typing payload is invalid.");
    return;
  }

  typingIndicatorUntilByPhone.set(to, Date.now() + TYPING_INDICATOR_MS);
  res.status(200).json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(uiDirectory, "index.html"));
});

app.listen(env.port, () => {
  console.log(`WhatsApp emulator listening on http://localhost:${env.port}`);
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates one caller phone and sends a safe API error when it is unknown.
 * @param res - Express response
 * @param callerPhone - Caller phone from the request
 * @returns Known caller details or null when already handled
 */
async function requireKnownCallerOrSendError(
  res: Response<ApiErrorResponseDto>,
  callerPhone: string
) {
  try {
    return await callerLookup.requireKnownCaller(callerPhone);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === "I could not find an account for this WhatsApp number.") {
      sendApiError(
        res,
        404,
        "UNKNOWN_CALLER_PHONE",
        "This phone number is not linked to a WhatsApp account in user settings."
      );
      return null;
    }

    throw error;
  }
}

/**
 * Stores one inbound or outbound chat message.
 * @param phone - Caller phone key
 * @param direction - Message direction
 * @param body - Message body
 * @param id - Stable message ID
 * @returns Void
 */
function storeMessage(
  phone: string,
  direction: "inbound" | "outbound",
  body: string,
  id: string
): void {
  const currentMessages = messagesByPhone.get(phone) ?? [];
  const nextMessages = [
    ...currentMessages,
    {
      body,
      createdAt: new Date().toISOString(),
      direction,
      id
    }
  ].slice(-MAX_STORED_MESSAGES);

  messagesByPhone.set(phone, nextMessages);
}

/**
 * Clears the active typing indicator for one phone.
 * @param phone - Caller phone key
 * @returns Void
 */
function clearTypingIndicator(phone: string): void {
  typingIndicatorUntilByPhone.delete(phone);
}

/**
 * Returns whether the emulator should render typing state.
 * @param phone - Caller phone key
 * @returns True when typing is still active
 */
function getIsTyping(phone: string): boolean {
  const activeUntil = typingIndicatorUntilByPhone.get(phone);
  if (!activeUntil) {
    return false;
  }

  if (activeUntil <= Date.now()) {
    typingIndicatorUntilByPhone.delete(phone);
    return false;
  }

  return true;
}

/**
 * Forwards one inbound text webhook to the existing WhatsApp server.
 * @param body - Meta-shaped webhook body
 * @returns Promise that resolves when the webhook is accepted
 */
async function forwardInboundTextWebhook(body: InboundTextWebhookBody): Promise<void> {
  const response = await fetch(new URL("/api/whatsapp/webhook", env.whatsappServerUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`WhatsApp webhook forward failed (${response.status}): ${responseText}`);
  }
}

/**
 * Reads a phone string from an Express query value.
 * @param value - Raw query value
 * @returns Trimmed phone string or empty string
 */
function getPhoneFromQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sends a safe API error response.
 * @param res - Express response
 * @param statusCode - HTTP status code
 * @param code - Stable error code
 * @param error - Safe user-facing error message
 * @returns Void
 */
function sendApiError(
  res: Response<ApiErrorResponseDto>,
  statusCode: number,
  code: string,
  error: string
): void {
  res.status(statusCode).json({
    code,
    error
  });
}
