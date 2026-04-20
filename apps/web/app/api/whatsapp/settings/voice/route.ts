/**
 * API route for WhatsApp-specific voice settings.
 *
 * Responsibilities:
 * - Authenticate the signed-in WhatsApp user
 * - Read the persisted WhatsApp voice config
 * - Validate and save WhatsApp voice changes
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import {
  listWhatsAppVoiceOptions,
  parseStoredWhatsAppVoiceConfig,
  parseWhatsAppVoiceUpdate,
  validateWhatsAppVoiceConfig,
} from "@/lib/whatsappVoice";

// ============================================================================
// TYPES
// ============================================================================

interface VoiceSettingsSuccessResponse {
  config: {
    provider: "deepgram";
    voiceId: string;
    speed: number;
  };
}

interface VoiceSettingsErrorResponse {
  code: string;
  error: string;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Loads the authenticated user and Supabase client for this request.
 * @returns Current Supabase user and client
 */
async function getAuthenticatedRequestContext(): Promise<{
  supabase: ReturnType<typeof createServerSupabaseClient>;
  userId: string | null;
}> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    supabase,
    userId: user?.id ?? null,
  };
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns the current WhatsApp voice config for the signed-in user.
 * @returns JSON response with the persisted config
 */
export async function GET(): Promise<
  NextResponse<VoiceSettingsSuccessResponse | VoiceSettingsErrorResponse>
> {
  const { supabase, userId } = await getAuthenticatedRequestContext();
  if (!userId) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", error: "You must sign in to manage WhatsApp voice settings." },
      { status: 401 }
    );
  }

  const { data, error } = await supabase
    .from("user_settings")
    .select("whatsapp_voice_config")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[whatsapp-voice-settings] failed to load settings", {
      userId,
      error: error.message,
    });
    return NextResponse.json(
      { code: "VOICE_SETTINGS_LOAD_FAILED", error: "We could not load WhatsApp voice settings." },
      { status: 500 }
    );
  }

  try {
    const config = parseStoredWhatsAppVoiceConfig(data?.whatsapp_voice_config ?? null);
    return NextResponse.json({ config });
  } catch (parseError) {
    console.error("[whatsapp-voice-settings] stored settings are invalid", {
      userId,
      error: parseError instanceof Error ? parseError.message : String(parseError),
    });
    return NextResponse.json(
      { code: "VOICE_SETTINGS_INVALID", error: "The saved WhatsApp voice settings are invalid." },
      { status: 500 }
    );
  }
}

/**
 * Saves the signed-in user's WhatsApp voice config.
 * @param request - Incoming request with voiceId and speed
 * @returns JSON response with the persisted config
 */
export async function PUT(
  request: NextRequest
): Promise<NextResponse<VoiceSettingsSuccessResponse | VoiceSettingsErrorResponse>> {
  const { supabase, userId } = await getAuthenticatedRequestContext();
  if (!userId) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", error: "You must sign in to manage WhatsApp voice settings." },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);

  let config;
  try {
    config = parseWhatsAppVoiceUpdate(body);
  } catch (validationError) {
    return NextResponse.json(
      {
        code: "INVALID_VOICE_SETTINGS",
        error: validationError instanceof Error ? validationError.message : "Invalid WhatsApp voice settings.",
      },
      { status: 400 }
    );
  }

  try {
    const options = await listWhatsAppVoiceOptions();
    validateWhatsAppVoiceConfig(config, options);
  } catch (optionsError) {
    console.error("[whatsapp-voice-settings] failed to validate options", {
      userId,
      error: optionsError instanceof Error ? optionsError.message : String(optionsError),
    });
    return NextResponse.json(
      { code: "VOICE_OPTIONS_LOAD_FAILED", error: "We could not verify the selected WhatsApp voice." },
      { status: 502 }
    );
  }

  const { error } = await supabase
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        whatsapp_voice_config: config,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("[whatsapp-voice-settings] failed to save settings", {
      userId,
      error: error.message,
    });
    return NextResponse.json(
      { code: "VOICE_SETTINGS_SAVE_FAILED", error: "We could not save WhatsApp voice settings." },
      { status: 500 }
    );
  }

  return NextResponse.json({ config });
}
