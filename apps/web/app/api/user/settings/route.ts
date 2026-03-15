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
import { createServerSupabaseClient } from "@/lib/supabase/client";
import type { UserSettings } from "@/lib/types";
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
    voicePreference: (row.voice_preference as string) ?? "alloy",
    toolApprovalConfig: (row.tool_approval_config as ToolApprovalConfig) ?? {},
    phoneNumber: (row.phone_number as string) ?? null,
    hasPin: !!row.pin_hash,
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
      voicePreference: "alloy",
      toolApprovalConfig: {},
      phoneNumber: null,
      hasPin: false,
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
    voice_preference: body.voicePreference,
    tool_approval_config: body.toolApprovalConfig,
  };

  // Store passwords directly for MVP. TODO: migrate to Supabase Vault.
  if (body.imapPassword) {
    upsertData.imap_password = body.imapPassword;
  }
  if (body.smtpPassword) {
    upsertData.smtp_password = body.smtpPassword;
  }
  if (body.pin) {
    upsertData.pin_hash = body.pin;
    upsertData.pin_locked = false;
    upsertData.pin_attempts = 0;
  }

  // TODO: Phase 3 -- Validate IMAP connection before saving

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
