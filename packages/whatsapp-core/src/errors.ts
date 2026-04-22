/**
 * Shared WhatsApp domain errors.
 *
 * Responsibilities:
 * - Expose explicit error types for invalid WhatsApp numbers
 * - Expose explicit error types for unknown WhatsApp-linked users
 */

// ============================================================================
// ERROR TYPES
// ============================================================================

export class InvalidWhatsAppPhoneError extends Error {
  /**
   * Creates an invalid-phone error.
   * @param phone - Raw phone value that failed validation
   */
  constructor(phone: string) {
    super(`Invalid WhatsApp phone: ${phone}`);
    this.name = "InvalidWhatsAppPhoneError";
  }
}

export class WhatsAppUserNotFoundError extends Error {
  /**
   * Creates an unknown-user error.
   * @param phone - Normalized WhatsApp phone that could not be linked
   */
  constructor(phone: string) {
    super(`No linked WhatsApp account found for ${phone}`);
    this.name = "WhatsAppUserNotFoundError";
  }
}
