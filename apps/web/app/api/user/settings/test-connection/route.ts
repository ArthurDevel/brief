/**
 * Tests IMAP and SMTP connections with the provided credentials.
 *
 * Attempts to connect to both servers and returns success/failure for each.
 * Used by the Email settings tab to validate credentials before saving.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Test IMAP connection via ImapFlow
 * - Test SMTP connection via nodemailer verify()
 * - Return per-protocol success/error results
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { createImapConnection, closeImapConnection } from "@dublin/email";
import nodemailer from "nodemailer";

// ============================================================================
// TYPES
// ============================================================================

interface TestConnectionRequest {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
}

interface TestResult {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Tests IMAP and SMTP connections with the provided credentials.
 * @param request - JSON body with IMAP/SMTP host, port, user, password
 * @returns TestResult with per-protocol success/error
 */
export async function POST(request: NextRequest): Promise<NextResponse<TestResult | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: TestConnectionRequest = await request.json();

  // Test both connections in parallel
  const [imapResult, smtpResult] = await Promise.all([
    testImap(body),
    testSmtp(body),
  ]);

  return NextResponse.json({ imap: imapResult, smtp: smtpResult });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Tests an IMAP connection by connecting and immediately logging out.
 * @param config - IMAP connection parameters
 * @returns Object with ok flag and optional error message
 */
async function testImap(config: TestConnectionRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await createImapConnection({
      host: config.imapHost,
      port: config.imapPort,
      user: config.imapUser,
      password: config.imapPassword,
    });
    await closeImapConnection(client);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "IMAP connection failed" };
  }
}

/**
 * Tests an SMTP connection by calling nodemailer's verify().
 * @param config - SMTP connection parameters
 * @returns Object with ok flag and optional error message
 */
async function testSmtp(config: TestConnectionRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPassword,
      },
    });
    await transport.verify();
    transport.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "SMTP connection failed" };
  }
}
