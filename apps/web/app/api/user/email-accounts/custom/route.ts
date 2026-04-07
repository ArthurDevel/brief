/**
 * API route for saving/updating a custom IMAP/SMTP email account.
 *
 * Validates the custom email account input, upserts the account row via
 * email-accounts helpers, and triggers contact invalidation when the
 * mailbox identity changes.
 *
 * Responsibilities:
 * - Authenticate the request via Supabase session
 * - Validate CustomEmailAccountInput body
 * - Detect mailbox identity changes by comparing old vs new imap_user
 * - Upsert the custom email account with Vault secret storage
 * - Delete user_contacts and trigger full contact sync on identity change
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { getActiveEmailAccount, upsertCustomEmailAccount } from "@/lib/email-accounts";
import type { EmailAccountSummary, CustomEmailAccountInput } from "@/lib/types";

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Saves or updates a custom IMAP/SMTP email account.
 * Triggers contact invalidation when the mailbox identity changes.
 * @param request - The incoming request with CustomEmailAccountInput body
 * @returns The upserted EmailAccountSummary
 */
export async function PUT(
  request: NextRequest
): Promise<NextResponse<EmailAccountSummary | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Validate required fields
  if (!body.imapHost || !body.imapPort || !body.imapUser) {
    return NextResponse.json({ error: "Missing required IMAP fields" }, { status: 400 });
  }
  if (!body.smtpHost || !body.smtpPort || !body.smtpUser) {
    return NextResponse.json({ error: "Missing required SMTP fields" }, { status: 400 });
  }

  const input: CustomEmailAccountInput = {
    provider: "custom",
    imapHost: body.imapHost,
    imapPort: body.imapPort,
    imapUser: body.imapUser,
    imapPassword: body.imapPassword,
    smtpHost: body.smtpHost,
    smtpPort: body.smtpPort,
    smtpUser: body.smtpUser,
    smtpPassword: body.smtpPassword,
  };

  // Load the existing active account to detect mailbox identity change
  const existingAccount = await getActiveEmailAccount(supabase, user.id);
  const oldImapUser = existingAccount?.emailAddress ?? null;

  const serviceClient = createServiceRoleClient();
  const summary = await upsertCustomEmailAccount(supabase, serviceClient, user.id, input);

  // If mailbox identity changed, invalidate contacts and trigger full sync
  const identityChanged = oldImapUser !== null && oldImapUser !== input.imapUser;
  if (identityChanged) {
    await invalidateContactsAndSync(serviceClient, user.id);
  } else if (!existingAccount) {
    // First-time setup: trigger full sync
    await triggerContactSync(user.id, "full");
  } else {
    // Same identity: trigger incremental sync
    await triggerContactSync(user.id, "incremental");
  }

  return NextResponse.json(summary);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Deletes all user_contacts for a user and triggers a full contact sync.
 * @param serviceClient - Supabase service-role client
 * @param userId - The user's ID
 */
async function invalidateContactsAndSync(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  userId: string
): Promise<void> {
  try {
    await serviceClient.from("user_contacts").delete().eq("user_id", userId);
    await triggerContactSync(userId, "full");
  } catch (err) {
    console.error("[email-accounts/custom] Failed to invalidate contacts:", err);
  }
}

/**
 * Triggers a contact sync via the voice pipeline.
 * @param userId - The user's ID
 * @param mode - "full" or "incremental"
 */
async function triggerContactSync(userId: string, mode: string): Promise<void> {
  try {
    console.log(`[email-accounts/custom] Triggering ${mode} contact sync for user ${userId}`);
    const syncResponse = await fetch(
      `${process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL}/sync-contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId, mode }),
      }
    );
    console.log(`[email-accounts/custom] Contact sync response: ${syncResponse.status}`);
  } catch (err) {
    console.error("[email-accounts/custom] Failed to trigger contact sync:", err);
  }
}
