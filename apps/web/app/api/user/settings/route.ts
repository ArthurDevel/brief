/**
 * API route for user settings (GET and PUT).
 *
 * GET returns the current user settings with passwords masked.
 * PUT upserts user settings, including IMAP/SMTP configuration,
 * voice preference, tool approval config, and PIN.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - GET: fetch and return settings from user_settings table
 * - PUT: validate and upsert settings
 * - Never expose raw passwords (return boolean flags instead)
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { storeSecret, updateSecret } from "@dublin/tools";
import type { UserSettings, UserPhone, CallSchedule } from "@/lib/types";
import type { ToolApprovalConfig } from "@dublin/tools/src/types";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets the authenticated user from the Supabase session.
 * @returns The user object or null
 */
async function getAuthenticatedUser() {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  return { user, supabase };
}

/**
 * Maps a database row to the UserSettings DTO.
 * @param row - The database row
 * @returns UserSettings with passwords masked
 */
function mapRowToSettings(row: Record<string, unknown>): UserSettings {
  return {
    imapHost: (row.imap_host as string) ?? "",
    imapPort: (row.imap_port as number) ?? 993,
    imapUser: (row.imap_user as string) ?? "",
    hasImapPassword: !!(row.imap_password || row.imap_password_secret_id),
    smtpHost: (row.smtp_host as string) ?? "",
    smtpPort: (row.smtp_port as number) ?? 587,
    smtpUser: (row.smtp_user as string) ?? "",
    hasSmtpPassword: !!(row.smtp_password || row.smtp_password_secret_id),
    voicePreference: ((row.voice_config as Record<string, unknown>)?.voice as string) ?? "aura-2-helena-en",
    voiceSpeed: ((row.voice_config as Record<string, unknown>)?.speed as number) ?? 1.0,
    toolApprovalConfig: (row.tool_approval_config as ToolApprovalConfig) ?? {},
    phone: (row.phone as UserPhone) ?? null,
    hasPin: !!row.pin_hash,
    callSchedule: (row.call_schedule as CallSchedule) ?? null,
  };
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns the current user settings with passwords masked.
 * @param _request - The incoming request (unused)
 * @returns JSON response with UserSettings
 */
export async function GET(_request: NextRequest): Promise<NextResponse<UserSettings | { error: string }>> {
  const { user, supabase } = await getAuthenticatedUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine for new users
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Return defaults for new users who have no settings row yet
  if (!data) {
    const defaults: UserSettings = {
      imapHost: "",
      imapPort: 993,
      imapUser: "",
      hasImapPassword: false,
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      hasSmtpPassword: false,
      voicePreference: "aura-2-helena-en",
      voiceSpeed: 1.0,
      toolApprovalConfig: {},
      phone: null,
      hasPin: false,
      callSchedule: null,
    };
    return NextResponse.json(defaults);
  }

  return NextResponse.json(mapRowToSettings(data));
}

/**
 * Upserts user settings.
 * @param request - The incoming request with settings payload
 * @returns JSON response with updated UserSettings
 */
export async function PUT(request: NextRequest): Promise<NextResponse<UserSettings | { error: string }>> {
  const { user, supabase } = await getAuthenticatedUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Build the upsert payload
  const upsertData: Record<string, unknown> = {
    user_id: user.id,
    imap_host: body.imapHost,
    imap_port: body.imapPort,
    imap_user: body.imapUser,
    smtp_host: body.smtpHost,
    smtp_port: body.smtpPort,
    smtp_user: body.smtpUser,
    voice_config: { voice: body.voicePreference, speed: body.voiceSpeed },
    tool_approval_config: body.toolApprovalConfig,
  };

  // Persist call schedule if provided, stripping last_call_at so the frontend cannot overwrite the dedup guard
  if (body.callSchedule !== undefined) {
    if (body.callSchedule === null) {
      upsertData.call_schedule = null;
    } else {
      const { last_call_at: _stripped, ...scheduleWithoutDedup } = body.callSchedule;
      upsertData.call_schedule = scheduleWithoutDedup;
    }
  }

  // Fetch existing settings to check for pre-existing secret IDs
  const { data: existing } = await supabase
    .from("user_settings")
    .select("imap_password_secret_id, smtp_password_secret_id")
    .eq("user_id", user.id)
    .single();

  // Store passwords in Supabase Vault using a service role client
  const serviceClient = createServiceRoleClient();

  if (body.imapPassword) {
    if (existing?.imap_password_secret_id && existing.imap_password_secret_id !== "placeholder-imap-secret") {
      await updateSecret(serviceClient, existing.imap_password_secret_id, body.imapPassword);
      upsertData.imap_password_secret_id = existing.imap_password_secret_id;
    } else {
      const secretId = await storeSecret(serviceClient, body.imapPassword, `imap-password-${user.id}`);
      upsertData.imap_password_secret_id = secretId;
    }
  }
  if (body.smtpPassword) {
    if (existing?.smtp_password_secret_id && existing.smtp_password_secret_id !== "placeholder-smtp-secret") {
      await updateSecret(serviceClient, existing.smtp_password_secret_id, body.smtpPassword);
      upsertData.smtp_password_secret_id = existing.smtp_password_secret_id;
    } else {
      const secretId = await storeSecret(serviceClient, body.smtpPassword, `smtp-password-${user.id}`);
      upsertData.smtp_password_secret_id = secretId;
    }
  }
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

  return NextResponse.json(mapRowToSettings(data));
}
