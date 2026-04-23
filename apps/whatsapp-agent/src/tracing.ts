/**
 * Shared Langfuse tracing helpers for the WhatsApp agent.
 *
 * Responsibilities:
 * - Build stable Langfuse session IDs for WhatsApp voice conversations
 * - Provide shared trace naming constants
 * - Mask sensitive values before spans are exported
 */

import { createHash } from "node:crypto";
import type { WhatsAppCallerContext } from "./lib/whatsappRuntime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
const LANGFUSE_PHONE_HASH_LENGTH = 12;
const LONG_SECRET_PATTERN = /\b(?:EA[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|pk-[A-Za-z0-9_-]+)\b/g;
const PHONE_NUMBER_PATTERN = /(?<!\w)\+?\d[\d\s().-]{6,}\d(?!\w)/g;
const REDACTED_PHONE_VALUE = "[redacted-phone]";
const REDACTED_SECRET_VALUE = "[redacted-secret]";
const WHATSAPP_VOICE_SESSION_PREFIX = "whatsapp-voice";

export const WHATSAPP_VOICE_TRACE_NAME = "whatsapp-voice-turn";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Builds the stable Langfuse session ID for one WhatsApp voice caller.
 * @param callerContext - Resolved WhatsApp caller context
 * @returns Stable session ID shared across voice turns for this caller
 */
export function buildWhatsAppVoiceSessionId(
  callerContext: WhatsAppCallerContext
): string {
  const phoneHash = createHash("sha256")
    .update(callerContext.callerPhone)
    .digest("hex")
    .slice(0, LANGFUSE_PHONE_HASH_LENGTH);

  return `${WHATSAPP_VOICE_SESSION_PREFIX}:${callerContext.supabaseUserId}:${phoneHash}`;
}

/**
 * Masks sensitive strings and objects before export to Langfuse.
 * @param data - Span attribute data
 * @returns Masked data with phone numbers and known secrets removed
 */
export function maskTracingData(data: unknown): unknown {
  if (typeof data === "string") {
    return maskSensitiveString(data);
  }

  if (Array.isArray(data)) {
    return data.map((entry) => maskTracingData(entry));
  }

  if (!data || typeof data !== "object") {
    return data;
  }

  if (data instanceof Date) {
    return data;
  }

  const maskedEntries = Object.entries(data).map(([key, value]) => [
    key,
    maskTracingData(value),
  ]);

  return Object.fromEntries(maskedEntries);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Masks sensitive substrings inside one string value.
 * @param value - Raw string value
 * @returns Masked string value
 */
function maskSensitiveString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_SECRET_VALUE}`)
    .replace(LONG_SECRET_PATTERN, REDACTED_SECRET_VALUE)
    .replace(PHONE_NUMBER_PATTERN, REDACTED_PHONE_VALUE);
}
