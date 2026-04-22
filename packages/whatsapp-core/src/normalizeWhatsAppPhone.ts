/**
 * WhatsApp phone normalization shared by text and voice runtimes.
 *
 * Responsibilities:
 * - Normalize raw WhatsApp numbers into E.164-style strings
 * - Reject obviously invalid values early
 */

// ============================================================================
// MAIN HELPER
// ============================================================================

/**
 * Normalizes a WhatsApp phone number into `+15551234567`.
 * @param rawPhone - Raw phone string from webhooks or forms
 * @returns Normalized phone number, or null when invalid
 */
export function normalizeWhatsAppPhone(rawPhone: string): string | null {
  const trimmedPhone = rawPhone.trim();
  if (!trimmedPhone) {
    return null;
  }

  const digitsOnly = trimmedPhone.replace(/[^\d]/g, "");
  if (digitsOnly.length < 8 || digitsOnly.length > 15) {
    return null;
  }

  return `+${digitsOnly}`;
}
