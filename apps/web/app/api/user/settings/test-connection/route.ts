/**
 * Tests IMAP and SMTP connections using stored credentials.
 *
 * Fetches the user's saved settings and passwords from Vault,
 * then attempts to connect to both servers.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Load IMAP/SMTP config + passwords from DB and Vault
 * - Test IMAP connection via createImapConnection
 * - Test SMTP connection via testSmtpConnection
 * - Return per-protocol success/error results
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { createImapConnection, closeImapConnection, testSmtpConnection } from "@dublin/email";
import { retrieveSecret } from "@dublin/tools";

// ============================================================================
// TYPES
// ============================================================================

interface TestResult {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Tests IMAP and SMTP connections using the user's stored credentials.
 * @param _request - The incoming request (no body needed)
 * @returns TestResult with per-protocol success/error
 */
export async function POST(_request: NextRequest): Promise<NextResponse<TestResult | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch stored settings
  const { data: settings, error: fetchError } = await supabase
    .from("user_settings")
    .select("imap_host, imap_port, imap_user, imap_password_secret_id, smtp_host, smtp_port, smtp_user, smtp_password_secret_id")
    .eq("user_id", user.id)
    .single();

  if (fetchError || !settings) {
    return NextResponse.json({ error: "No email settings found. Please save your settings first." }, { status: 400 });
  }

  if (!settings.imap_password_secret_id || !settings.smtp_password_secret_id) {
    return NextResponse.json({ error: "Missing stored passwords. Please re-enter your credentials." }, { status: 400 });
  }

  // Retrieve passwords from Vault
  const serviceClient = createServiceRoleClient();
  const [imapPassword, smtpPassword] = await Promise.all([
    retrieveSecret(serviceClient, settings.imap_password_secret_id),
    retrieveSecret(serviceClient, settings.smtp_password_secret_id),
  ]);

  // Test both connections in parallel
  const [imapResult, smtpResult] = await Promise.all([
    testImap(settings.imap_host, settings.imap_port, settings.imap_user, imapPassword),
    testSmtpConnection({
      host: settings.smtp_host,
      port: settings.smtp_port,
      user: settings.smtp_user,
      password: smtpPassword,
    }),
  ]);

  return NextResponse.json({ imap: imapResult, smtp: smtpResult });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Tests an IMAP connection by connecting and immediately logging out.
 * @param host - IMAP server hostname
 * @param port - IMAP server port
 * @param user - IMAP username
 * @param password - IMAP password (decrypted)
 * @returns Object with ok flag and optional error message
 */
async function testImap(host: string, port: number, user: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await createImapConnection({ host, port, user, password });
    await closeImapConnection(client);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "IMAP connection failed" };
  }
}
