/**
 * Tests for the custom email account route validation logic.
 *
 * Verifies:
 * - Required IMAP fields are validated (host, port, user)
 * - Required SMTP fields are validated (host, port, user)
 * - Valid input passes validation
 */

import { describe, it, expect } from "vitest";
import type { CustomEmailAccountInput } from "@/lib/types";

// ============================================================================
// VALIDATION LOGIC -- mirrors the route's body validation
// ============================================================================

/**
 * Validates a custom email account input body.
 * Returns an error message if validation fails, null if valid.
 */
function validateCustomAccountInput(
  body: Record<string, unknown>
): string | null {
  if (!body.imapHost || !body.imapPort || !body.imapUser) {
    return "Missing required IMAP fields";
  }
  if (!body.smtpHost || !body.smtpPort || !body.smtpUser) {
    return "Missing required SMTP fields";
  }
  return null;
}

// ============================================================================
// TESTS
// ============================================================================

describe("custom email account input validation", () => {
  const validInput: CustomEmailAccountInput = {
    provider: "custom",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapUser: "user@example.com",
    imapPassword: "secret",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "user@example.com",
    smtpPassword: "secret",
  };

  it("accepts valid input with all fields", () => {
    expect(validateCustomAccountInput(validInput as unknown as Record<string, unknown>)).toBeNull();
  });

  it("rejects missing imapHost", () => {
    const input = { ...validInput, imapHost: "" };
    expect(validateCustomAccountInput(input)).toBe("Missing required IMAP fields");
  });

  it("rejects missing imapPort", () => {
    const input = { ...validInput, imapPort: 0 };
    expect(validateCustomAccountInput(input)).toBe("Missing required IMAP fields");
  });

  it("rejects missing imapUser", () => {
    const input = { ...validInput, imapUser: "" };
    expect(validateCustomAccountInput(input)).toBe("Missing required IMAP fields");
  });

  it("rejects missing smtpHost", () => {
    const input = { ...validInput, smtpHost: "" };
    expect(validateCustomAccountInput(input)).toBe("Missing required SMTP fields");
  });

  it("rejects missing smtpPort", () => {
    const input = { ...validInput, smtpPort: 0 };
    expect(validateCustomAccountInput(input)).toBe("Missing required SMTP fields");
  });

  it("rejects missing smtpUser", () => {
    const input = { ...validInput, smtpUser: "" };
    expect(validateCustomAccountInput(input)).toBe("Missing required SMTP fields");
  });

  it("accepts input without passwords (password update is optional)", () => {
    const { imapPassword: _a, smtpPassword: _b, ...inputWithoutPasswords } = validInput;
    expect(validateCustomAccountInput(inputWithoutPasswords)).toBeNull();
  });
});
