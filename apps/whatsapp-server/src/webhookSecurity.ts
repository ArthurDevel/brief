/**
 * Validates WhatsApp webhook requests before business logic runs.
 *
 * Responsibilities:
 * - Read the Meta app secret from environment variables
 * - Verify `X-Hub-Signature-256` against the raw webhook body
 * - Check whether a request uses a JSON content type
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================================
// CONSTANTS
// ============================================================================

const JSON_CONTENT_TYPE = "application/json";
const WEBHOOK_SIGNATURE_PREFIX = "sha256=";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the Meta app secret used for webhook signature verification.
 * @returns Meta app secret from environment variables
 */
export function getMetaAppSecret(): string {
  const appSecret = process.env.META_APP_SECRET?.trim();

  if (!appSecret) {
    throw new Error("META_APP_SECRET environment variable is required for WhatsApp webhooks");
  }

  return appSecret;
}

/**
 * Returns true when the provided content type is JSON.
 * @param contentType - Incoming Content-Type header value
 * @returns True when the request should be treated as JSON
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.toLowerCase().includes(JSON_CONTENT_TYPE);
}

/**
 * Verifies the Meta webhook signature against the raw request body.
 * @param rawBody - Exact raw request body bytes from the webhook request
 * @param signatureHeader - `X-Hub-Signature-256` header value
 * @param appSecret - Meta app secret from environment variables
 * @returns True when the signature is valid
 */
export function isValidMetaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(WEBHOOK_SIGNATURE_PREFIX)) {
    return false;
  }

  const expectedSignature = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const receivedSignature = signatureHeader.slice(WEBHOOK_SIGNATURE_PREFIX.length);

  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(receivedSignature, "utf8"),
    Buffer.from(expectedSignature, "utf8")
  );
}
