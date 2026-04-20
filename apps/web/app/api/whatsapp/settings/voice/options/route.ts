/**
 * API route for available WhatsApp voice options.
 *
 * Responsibilities:
 * - Authenticate the signed-in WhatsApp user
 * - Load dynamic voice options from the active provider
 * - Return a normalized DTO for the WhatsApp settings page
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { listWhatsAppVoiceOptions, type WhatsAppVoiceOption } from "@/lib/whatsappVoice";

// ============================================================================
// TYPES
// ============================================================================

interface VoiceOptionsSuccessResponse {
  options: WhatsAppVoiceOption[];
}

interface VoiceOptionsErrorResponse {
  code: string;
  error: string;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Returns the dynamic WhatsApp voice options for the signed-in user.
 * @returns JSON response with normalized voice options
 */
export async function GET(): Promise<
  NextResponse<VoiceOptionsSuccessResponse | VoiceOptionsErrorResponse>
> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", error: "You must sign in to load WhatsApp voice options." },
      { status: 401 }
    );
  }

  try {
    const options = await listWhatsAppVoiceOptions();
    return NextResponse.json({ options });
  } catch (error) {
    console.error("[whatsapp-voice-options] failed to load options", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { code: "VOICE_OPTIONS_LOAD_FAILED", error: "We could not load WhatsApp voice options." },
      { status: 502 }
    );
  }
}
