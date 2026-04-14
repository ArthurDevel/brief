/**
 * Tests email connection status based on the active email account type.
 *
 * For custom IMAP/SMTP accounts: fetches credentials from Vault and tests
 * actual socket connections to both servers.
 * For Unipile-backed accounts: calls Unipile getAccount to check status.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Load the active email account from user_email_accounts
 * - Branch by connection type (imap_smtp vs unipile)
 * - Custom: test IMAP + SMTP connections using stored Vault credentials
 * - Unipile: check account status via Unipile API
 * - Return per-protocol success/error results
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { createImapConnection, closeImapConnection, testSmtpConnection } from "@dublin/email";
import { retrieveSecret } from "@dublin/tools";
import { getActiveEmailAccount } from "@/lib/email-accounts";
import { getAccount } from "@/lib/unipile/client";
import {
  getConnectionErrorMessage,
  type EmailStatus,
} from "@/lib/email-status";

// ============================================================================
// TYPES
// ============================================================================

interface TestResult {
  status: EmailStatus;
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Tests the email connection for the user's active account.
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

  // Load active email account
  const account = await getActiveEmailAccount(supabase, user.id);

  if (!account) {
    return NextResponse.json(
      { error: "No email account configured. Please set up your email first." },
      { status: 400 }
    );
  }

  // Branch by connection type
  if (account.connectionType === "unipile") {
    return testUnipileConnection(account.id, supabase, user.id);
  }

  return testCustomConnection(account.id, supabase, user.id);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Tests a Unipile-backed account by checking its status via the Unipile API.
 * @param accountId - The email account row ID
 * @param supabase - Supabase client for loading the Unipile account ID
 * @param userId - The user's ID
 * @returns TestResult derived from Unipile account status
 */
async function testUnipileConnection(
  accountId: string,
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<NextResponse<TestResult | { error: string }>> {
  // Load the unipile_account_id from the database
  const { data: row, error: fetchError } = await supabase
    .from("user_email_accounts")
    .select("unipile_account_id")
    .eq("id", accountId)
    .eq("user_id", userId)
    .single();

  if (fetchError || !row?.unipile_account_id) {
    return NextResponse.json(
      { error: "Unipile account ID not found." },
      { status: 400 }
    );
  }

  try {
    const unipileAccount = await getAccount(row.unipile_account_id);
    const isOk = unipileAccount.status === "connected";
    const message = isOk
      ? null
      : `Unipile account status: ${unipileAccount.status}`;

    await updateStoredStatus(
      supabase,
      accountId,
      userId,
      unipileAccount.status as EmailStatus,
      message
    );

    return NextResponse.json({
      status: unipileAccount.status as EmailStatus,
      imap: isOk
        ? { ok: true }
        : { ok: false, error: message ?? undefined },
      smtp: isOk
        ? { ok: true }
        : { ok: false, error: message ?? undefined },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unipile status check failed";
    await updateStoredStatus(supabase, accountId, userId, "error", message);
    return NextResponse.json({
      status: "error",
      imap: { ok: false, error: message },
      smtp: { ok: false, error: message },
    });
  }
}

/**
 * Tests a custom IMAP/SMTP account by connecting to both servers.
 * @param supabase - Supabase client for loading account config
 * @param userId - The user's ID
 * @returns TestResult with per-protocol results
 */
async function testCustomConnection(
  accountId: string,
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<NextResponse<TestResult | { error: string }>> {
  // Load custom account details
  const { data: account, error: fetchError } = await supabase
    .from("user_email_accounts")
    .select(
      "imap_host, imap_port, imap_user, imap_password_secret_id, smtp_host, smtp_port, smtp_user, smtp_password_secret_id"
    )
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("connection_type", "imap_smtp")
    .single();

  if (fetchError || !account) {
    return NextResponse.json(
      { error: "No custom email settings found. Please save your settings first." },
      { status: 400 }
    );
  }

  if (!account.imap_password_secret_id || !account.smtp_password_secret_id) {
    return NextResponse.json(
      { error: "Missing stored passwords. Please re-enter your credentials." },
      { status: 400 }
    );
  }

  // Retrieve passwords from Vault
  const serviceClient = createServiceRoleClient();
  const [imapPassword, smtpPassword] = await Promise.all([
    retrieveSecret(serviceClient, account.imap_password_secret_id),
    retrieveSecret(serviceClient, account.smtp_password_secret_id),
  ]);

  // Test both connections in parallel
  const [imapResult, smtpResult] = await Promise.all([
    testImap(account.imap_host, account.imap_port, account.imap_user, imapPassword),
    testSmtpConnection({
      host: account.smtp_host,
      port: account.smtp_port,
      user: account.smtp_user,
      password: smtpPassword,
    }),
  ]);

  const status: EmailStatus =
    imapResult.ok && smtpResult.ok ? "connected" : "error";
  const message = getConnectionErrorMessage({ imap: imapResult, smtp: smtpResult }) ?? null;
  await updateStoredStatus(supabase, accountId, userId, status, message);

  return NextResponse.json({ status, imap: imapResult, smtp: smtpResult });
}

/**
 * Tests an IMAP connection by connecting and immediately logging out.
 * @param host - IMAP server hostname
 * @param port - IMAP server port
 * @param user - IMAP username
 * @param password - IMAP password (decrypted)
 * @returns Object with ok flag and optional error message
 */
async function testImap(
  host: string,
  port: number,
  user: string,
  password: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await createImapConnection({ host, port, user, password });
    await closeImapConnection(client);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "IMAP connection failed" };
  }
}

async function updateStoredStatus(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  accountId: string,
  userId: string,
  status: EmailStatus,
  message: string | null
): Promise<void> {
  const { error } = await supabase
    .from("user_email_accounts")
    .update({
      status,
      last_error: message,
    })
    .eq("id", accountId)
    .eq("user_id", userId);

  if (error) {
    console.error("[user/settings/test-connection] Failed to persist email status:", error.message);
  }
}
