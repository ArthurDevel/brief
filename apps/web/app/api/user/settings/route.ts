/**
 * API route for user settings (GET and PUT).
 *
 * GET returns the current user settings including the active email account
 * summary read from user_email_accounts.
 * PUT upserts non-email settings: voice preference, voice speed, tool
 * approval config, PIN, and call schedule.
 *
 * Email account management is handled entirely by the email-accounts routes.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - GET: fetch settings + active email account summary
 * - PUT: validate and upsert non-email settings with partial-update semantics
 * - Never expose raw passwords or PIN hashes
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getActiveEmailAccount } from "@/lib/email-accounts";
import type { UserSettings } from "@/lib/types";
import {
  getDefaultUserSettings,
  getUserSettingsDomainDefaults,
  mapUserSettingsRowToSettings,
} from "@/lib/user-settings-defaults";

/**
 * Gets the authenticated user from the Supabase session.
 * @returns The user object and supabase client, or null user if unauthenticated
 */
async function getAuthenticatedUser() {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  return { user, supabase };
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns the current user settings including the active email account summary.
 * @param _request - The incoming request (unused)
 * @returns JSON response with UserSettings
 */
export async function GET(_request: NextRequest): Promise<NextResponse<UserSettings | { error: string }>> {
  const { user, supabase } = await getAuthenticatedUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load settings and email account in parallel
  const [settingsResult, emailAccount] = await Promise.all([
    supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", user.id)
      .single(),
    getActiveEmailAccount(supabase, user.id),
  ]);

  const { data, error } = settingsResult;

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine for new users
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Return defaults for new users who have no settings row yet
  if (!data) {
    return NextResponse.json(getDefaultUserSettings(emailAccount));
  }

  return NextResponse.json(mapUserSettingsRowToSettings(data, emailAccount));
}

/**
 * Upserts non-email user settings.
 * Supports partial updates: only provided fields are written.
 * @param request - The incoming request with settings payload
 * @returns JSON response with updated UserSettings
 */
export async function PUT(request: NextRequest): Promise<NextResponse<UserSettings | { error: string }>> {
  const { user, supabase } = await getAuthenticatedUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Build the upsert payload -- only include fields that were provided
  const upsertData: Record<string, unknown> = {
    user_id: user.id,
  };

  // Voice settings
  if (body.voicePreference !== undefined || body.voiceSpeed !== undefined) {
    // Load existing voice config to merge partial updates
    const { data: existing } = await supabase
      .from("user_settings")
      .select("voice_config")
      .eq("user_id", user.id)
      .single();

    const existingVoice = (existing?.voice_config as Record<string, unknown>) ?? {};
    const defaultVoiceConfig = getUserSettingsDomainDefaults().voice_config;
    upsertData.voice_config = {
      voice: body.voicePreference ?? existingVoice.voice ?? defaultVoiceConfig.voice,
      speed: body.voiceSpeed ?? existingVoice.speed ?? defaultVoiceConfig.speed,
    };
  }

  // Tool approval config
  if (body.toolApprovalConfig !== undefined) {
    upsertData.tool_approval_config = body.toolApprovalConfig;
  }

  // Call schedule
  if (body.callSchedule !== undefined) {
    if (body.callSchedule === null) {
      upsertData.call_schedule = null;
    } else {
      // Strip last_call_at so the frontend cannot overwrite the dedup guard
      const { last_call_at: _stripped, ...scheduleWithoutDedup } = body.callSchedule;
      upsertData.call_schedule = scheduleWithoutDedup;
    }
  }

  // PIN
  if (body.pin) {
    const bcrypt = await import("bcryptjs");
    upsertData.pin_hash = await bcrypt.hash(body.pin, 10);
    upsertData.pin_locked = false;
    upsertData.pin_attempts = 0;
  }

  const { data, error } = await supabase
    .from("user_settings")
    .upsert(upsertData, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Load email account for the response
  const emailAccount = await getActiveEmailAccount(supabase, user.id);

  return NextResponse.json(mapUserSettingsRowToSettings(data, emailAccount));
}
