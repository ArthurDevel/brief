/**
 * Supabase caller validation for the WhatsApp emulator.
 *
 * Responsibilities:
 * - Validate that an emulator caller phone is already linked to a user
 * - Return the matching user identity for logging and debugging
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EmulatorEnv } from "./env.js";
import type { KnownCallerDto } from "./types.js";

// ============================================================================
// TYPES
// ============================================================================

interface CallerLookupRow {
  user_id: string;
  whatsapp_phone: string;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export class SupabaseCallerLookup {
  private readonly supabase: SupabaseClient;

  /**
   * Creates a caller lookup service.
   * @param env - Emulator environment config
   */
  constructor(env: EmulatorEnv) {
    this.supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  /**
   * Validates that the caller phone already exists in user settings.
   * @param callerPhone - Caller phone number entered in the emulator
   * @returns Linked caller details
   */
  async requireKnownCaller(callerPhone: string): Promise<KnownCallerDto> {
    const normalizedPhone = normalizeCallerPhone(callerPhone);
    if (!normalizedPhone) {
      throw new Error("Caller phone must be a valid WhatsApp number.");
    }

    const { data, error } = await this.supabase
      .from("user_settings")
      .select("user_id, whatsapp_phone")
      .eq("whatsapp_phone", normalizedPhone)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to validate the caller phone: ${error.message}`);
    }

    const callerRow = data as CallerLookupRow | null;
    if (!callerRow?.user_id || !callerRow.whatsapp_phone) {
      throw new Error("I could not find an account for this WhatsApp number.");
    }

    return {
      phone: callerRow.whatsapp_phone,
      userId: callerRow.user_id
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalizes an emulator caller phone into E.164.
 * @param rawPhone - Raw caller phone from the emulator UI
 * @returns E.164 phone number or null when invalid
 */
function normalizeCallerPhone(rawPhone: string): string | null {
  const trimmed = rawPhone.trim();
  if (!trimmed) {
    return null;
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  if (digitsOnly.length < 8 || digitsOnly.length > 15) {
    return null;
  }

  return `+${digitsOnly}`;
}
