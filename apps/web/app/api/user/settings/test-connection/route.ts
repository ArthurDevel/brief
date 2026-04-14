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
  getDashboardErrorMessage,
  type DashboardErrorCode,
} from "@/lib/errors/dashboardErrors";
import { mapDashboardErrorDetails } from "@/lib/errors/mapDashboardError";

// ============================================================================
// TYPES
// ============================================================================

interface TestResult {
  imap: { ok: boolean; code?: DashboardErrorCode; error?: string };
  smtp: { ok: boolean; code?: DashboardErrorCode; error?: string };
}

interface ErrorResponse {
  code: DashboardErrorCode;
  error: string;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Tests the email connection for the user's active account.
 * @param _request - The incoming request (no body needed)
 * @returns TestResult with per-protocol success/error
 */
export async function POST(_request: NextRequest): Promise<NextResponse<TestResult | ErrorResponse>> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return errorResponse("UNAUTHORIZED", 401);
    }

    const account = await getActiveEmailAccount(supabase, user.id);

    if (!account) {
      return errorResponse("EMAIL_ACCOUNT_REQUIRED", 400);
    }

    if (account.connectionType === "unipile") {
      return testUnipileConnection(account.id, supabase, user.id);
    }

    return testCustomConnection(supabase, user.id);
  } catch (err) {
    console.error("[user/settings/test-connection]", err);
    const { code, message } = mapDashboardErrorDetails(
      err,
      "settings-email",
      "EMAIL_VERIFY_FAILED"
    );
    return NextResponse.json({ code, error: message }, { status: 500 });
  }
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
): Promise<NextResponse<TestResult | ErrorResponse>> {
  // Load the unipile_account_id from the database
  const { data: row, error: fetchError } = await supabase
    .from("user_email_accounts")
    .select("unipile_account_id")
    .eq("id", accountId)
    .eq("user_id", userId)
    .single();

  if (fetchError || !row?.unipile_account_id) {
    console.error("[user/settings/test-connection]", {
      message: "Missing Unipile account ID",
      fetchError,
      accountId,
      userId,
    });
    return errorResponse("EMAIL_CONNECT_FAILED", 400);
  }

  try {
    const unipileAccount = await getAccount(row.unipile_account_id);
    const isOk = unipileAccount.status === "connected";
    const failure = isOk
      ? undefined
      : buildProtocolFailure(
        { error: `Unipile account status: ${unipileAccount.status}` },
        "EMAIL_VERIFY_FAILED"
      );

    return NextResponse.json({
      imap: isOk ? { ok: true } : failure!,
      smtp: isOk ? { ok: true } : failure!,
    });
  } catch (err) {
    console.error("[user/settings/test-connection]", err);
    const failure = buildProtocolFailure(err, "EMAIL_VERIFY_FAILED");
    return NextResponse.json({
      imap: failure,
      smtp: failure,
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
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<NextResponse<TestResult | ErrorResponse>> {
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
    console.error("[user/settings/test-connection]", {
      message: "No custom email settings found",
      fetchError,
      userId,
    });
    return errorResponse("EMAIL_ACCOUNT_REQUIRED", 400);
  }

  if (!account.imap_password_secret_id || !account.smtp_password_secret_id) {
    return errorResponse("EMAIL_PASSWORDS_REQUIRED", 400);
  }

  try {
    const serviceClient = createServiceRoleClient();
    const [imapPassword, smtpPassword] = await Promise.all([
      retrieveSecret(serviceClient, account.imap_password_secret_id),
      retrieveSecret(serviceClient, account.smtp_password_secret_id),
    ]);

    const [imapResult, smtpResult] = await Promise.all([
      testImap(account.imap_host, account.imap_port, account.imap_user, imapPassword),
      testSmtpConnection({
        host: account.smtp_host,
        port: account.smtp_port,
        user: account.smtp_user,
        password: smtpPassword,
      }),
    ]);

    return NextResponse.json({
      imap: imapResult.ok ? { ok: true } : buildProtocolFailure(imapResult.error, "EMAIL_INBOX_VERIFY_FAILED"),
      smtp: smtpResult.ok ? { ok: true } : buildProtocolFailure(smtpResult.error, "EMAIL_SMTP_VERIFY_FAILED"),
    });
  } catch (err) {
    console.error("[user/settings/test-connection]", err);
    return errorResponse("EMAIL_VERIFY_FAILED", 500);
  }
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

function errorResponse(
  code: DashboardErrorCode,
  status: number
): NextResponse<ErrorResponse> {
  return NextResponse.json(
    { code, error: getDashboardErrorMessage(code) },
    { status }
  );
}

function buildProtocolFailure(
  error: unknown,
  fallbackCode: DashboardErrorCode
): { ok: false; code: DashboardErrorCode; error: string } {
  console.error("[user/settings/test-connection]", error);
  const { code, message } = mapDashboardErrorDetails(error, "settings-email", fallbackCode);
  return { ok: false, code, error: message };
}
