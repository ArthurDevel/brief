/**
 * Tests for the Unipile notify callback HMAC verification.
 *
 * Verifies:
 * - Valid HMAC-signed token returns the correct user ID
 * - Tampered signature is rejected
 * - Missing parts (incomplete token) is rejected
 * - Empty token is rejected
 * - Token with modified timestamp is rejected
 */

import { createHmac, timingSafeEqual } from "crypto";
import { describe, it, expect } from "vitest";

// ============================================================================
// verifyCorrelationToken -- replicated from notify/route.ts since it's private
// ============================================================================

/**
 * Verifies an HMAC-signed correlation token and extracts the user ID.
 * Token format: userId:timestamp:hmacSignature
 * @param token - The correlation token from the Unipile callback
 * @param secret - The HMAC secret key
 * @returns The user ID if verification succeeds, null otherwise
 */
function verifyCorrelationToken(token: string, secret: string): string | null {
  const parts = token.split(":");
  if (parts.length < 3) {
    return null;
  }

  const signature = parts[parts.length - 1];
  const timestamp = parts[parts.length - 2];
  const userId = parts.slice(0, parts.length - 2).join(":");

  if (!userId || !timestamp || !signature) {
    return null;
  }

  const payload = `${userId}:${timestamp}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");

  if (a.length !== b.length) {
    return null;
  }

  if (!timingSafeEqual(a, b)) {
    return null;
  }

  return userId;
}

// ============================================================================
// HELPERS
// ============================================================================

const TEST_SECRET = "test-notify-secret-key";
const TEST_USER_ID = "user-abc-123";
const TEST_TIMESTAMP = "1700000000";

/**
 * Creates a valid HMAC-signed correlation token.
 */
function createToken(userId: string, timestamp: string, secret: string): string {
  const payload = `${userId}:${timestamp}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${userId}:${timestamp}:${signature}`;
}

// ============================================================================
// TESTS
// ============================================================================

describe("verifyCorrelationToken", () => {
  it("returns userId for a valid token", () => {
    const token = createToken(TEST_USER_ID, TEST_TIMESTAMP, TEST_SECRET);
    const result = verifyCorrelationToken(token, TEST_SECRET);

    expect(result).toBe(TEST_USER_ID);
  });

  it("rejects a tampered signature", () => {
    const token = createToken(TEST_USER_ID, TEST_TIMESTAMP, TEST_SECRET);
    // Replace last hex character
    const tampered = token.slice(0, -1) + (token.slice(-1) === "0" ? "1" : "0");

    const result = verifyCorrelationToken(tampered, TEST_SECRET);

    expect(result).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = createToken(TEST_USER_ID, TEST_TIMESTAMP, "wrong-secret");
    const result = verifyCorrelationToken(token, TEST_SECRET);

    expect(result).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(verifyCorrelationToken("", TEST_SECRET)).toBeNull();
  });

  it("rejects a token with fewer than 3 parts", () => {
    expect(verifyCorrelationToken("only-two:parts", TEST_SECRET)).toBeNull();
  });

  it("rejects a token with a modified timestamp", () => {
    const token = createToken(TEST_USER_ID, TEST_TIMESTAMP, TEST_SECRET);
    // Replace timestamp portion
    const parts = token.split(":");
    parts[parts.length - 2] = "9999999999";
    const modified = parts.join(":");

    const result = verifyCorrelationToken(modified, TEST_SECRET);

    expect(result).toBeNull();
  });

  it("handles user IDs that contain colons", () => {
    const userWithColon = "org:user:abc-123";
    const token = createToken(userWithColon, TEST_TIMESTAMP, TEST_SECRET);

    const result = verifyCorrelationToken(token, TEST_SECRET);

    expect(result).toBe(userWithColon);
  });
});
