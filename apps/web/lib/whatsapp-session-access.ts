/**
 * Resolves WhatsApp session access data from the shared sessions table.
 *
 * Responsibilities:
 * - Load the session owner for a WhatsApp session link
 * - Load the WhatsApp phone linked to that owner
 * - Return one DTO that route handlers and pages can reuse
 */

import { createServiceRoleClient } from "@/lib/supabase/client";

// ============================================================================
// TYPES
// ============================================================================

export interface WhatsAppSessionAccess {
  sessionId: string;
  userId: string;
  whatsappPhone: string;
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Loads the WhatsApp-linked account that owns one session.
 * @param sessionId - Session ID from the sessions table
 * @returns Session access data or null when the session is missing or not linked
 */
export async function getWhatsAppSessionAccess(
  sessionId: string
): Promise<WhatsAppSessionAccess | null> {
  const supabase = createServiceRoleClient();

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    throw new Error(`Failed to load WhatsApp session: ${sessionError.message}`);
  }

  if (!session?.id || !session.user_id) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_settings")
    .select("whatsapp_phone")
    .eq("user_id", session.user_id)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to load WhatsApp session owner: ${profileError.message}`);
  }

  if (!profile?.whatsapp_phone || typeof profile.whatsapp_phone !== "string") {
    return null;
  }

  return {
    sessionId: session.id,
    userId: session.user_id,
    whatsappPhone: profile.whatsapp_phone,
  };
}
