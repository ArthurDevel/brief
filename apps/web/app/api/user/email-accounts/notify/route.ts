/**
 * Unipile notify_url callback endpoint.
 *
 * Receives POST callbacks from Unipile when a hosted auth flow completes.
 * Verifies the HMAC-signed correlation token, fetches account metadata
 * from Unipile, and upserts the user's email account row.
 *
 * No user authentication (no cookies) -- uses HMAC verification on the
 * name field instead.
 *
 * Responsibilities:
 * - Verify the HMAC signature on the name (correlation token) field
 * - Extract the user ID from the verified token
 * - Fetch account metadata from Unipile (email address, provider type)
 * - Upsert user_email_accounts row with Unipile connection details
 * - Handle both CREATION_SUCCESS and RECONNECTED callback statuses
 * - Invalidate user_contacts if the mailbox identity changed
 */

import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAccount, deleteAccount } from "@/lib/unipile/client";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maps Unipile account type strings to our provider enum */
const UNIPILE_TYPE_TO_PROVIDER: Record<string, "gmail" | "outlook"> = {
  GOOGLE: "gmail",
  GOOGLE_OAUTH: "gmail",
  OUTLOOK: "outlook",
};

/** Callback statuses we consider as successful connection */
const SUCCESS_STATUSES = ["CREATION_SUCCESS", "RECONNECTED"];

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Handles Unipile notify_url callbacks after hosted auth completes.
 * @param request - The incoming Unipile callback with { status, account_id, name }
 * @returns 200 on success, 400/401 on verification failure
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<{ ok: boolean } | { error: string }>> {
  const body = await request.json();

  const { status, account_id, name } = body as {
    status: string;
    account_id: string;
    name: string;
  };

  if (!status || !account_id || !name) {
    return NextResponse.json(
      { error: "Missing required fields: status, account_id, name" },
      { status: 400 }
    );
  }

  // Verify the HMAC-signed correlation token
  const notifySecret = process.env.UNIPILE_NOTIFY_SECRET;
  if (!notifySecret) {
    throw new Error("UNIPILE_NOTIFY_SECRET environment variable is not set");
  }

  const userId = verifyCorrelationToken(name, notifySecret);
  if (!userId) {
    return NextResponse.json(
      { error: "Invalid or tampered correlation token" },
      { status: 401 }
    );
  }

  // Only process successful connection statuses
  if (!SUCCESS_STATUSES.includes(status)) {
    console.log(
      `[email-accounts/notify] Ignoring non-success status "${status}" for user ${userId}`
    );
    return NextResponse.json({ ok: true });
  }

  // Fetch account metadata from Unipile
  const unipileAccount = await getAccount(account_id);
  const provider = UNIPILE_TYPE_TO_PROVIDER[unipileAccount.type];
  if (!provider) {
    throw new Error(
      `Unknown Unipile account type: ${unipileAccount.type}`
    );
  }

  // Use a service-role client since this endpoint has no user session
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Check for existing active account to detect mailbox identity change
  const { data: existingAccount } = await serviceClient
    .from("user_email_accounts")
    .select("id, email_address, unipile_account_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  const oldEmail = existingAccount?.email_address ?? null;
  const newEmail = unipileAccount.email;
  const identityChanged = oldEmail !== null && oldEmail !== newEmail;

  // Deactivate old account if identity changed
  if (identityChanged && existingAccount) {
    await serviceClient
      .from("user_email_accounts")
      .update({ is_active: false })
      .eq("id", existingAccount.id);
  }

  // Delete the old Unipile account if the unipile_account_id changed.
  // This covers both identity changes (different email) AND provider switches
  // with the same email (e.g. Outlook -> Gmail on the same mailbox).
  const oldUnipileId = existingAccount?.unipile_account_id as string | null;
  const unipileAccountChanged = oldUnipileId && oldUnipileId !== account_id;
  if (unipileAccountChanged) {
    try {
      await deleteAccount(oldUnipileId);
      console.log(`[email-accounts/notify] Deleted old Unipile account ${oldUnipileId}`);
    } catch (err) {
      console.error("[email-accounts/notify] Failed to delete old Unipile account:", err);
    }
  }

  // Determine which DB row to write to:
  // 1. Same identity (reconnect / connection-type switch) -> reuse active row
  // 2. Identity changed but an inactive row with the same email exists -> reactivate it
  // 3. Otherwise -> insert a new row
  let reuseRowId: string | null = null;

  if (existingAccount && !identityChanged) {
    reuseRowId = existingAccount.id as string;
  } else if (identityChanged) {
    const { data: inactiveRow } = await serviceClient
      .from("user_email_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("email_address", newEmail)
      .eq("is_active", false)
      .maybeSingle();

    if (inactiveRow) {
      reuseRowId = inactiveRow.id as string;
    }
  }

  const accountRow = {
    user_id: userId,
    provider,
    connection_type: "unipile" as const,
    email_address: newEmail,
    unipile_account_id: account_id,
    status: "connected" as const,
    last_error: null,
    is_active: true,
    connected_at: new Date().toISOString(),
    // Clear custom IMAP/SMTP fields for Unipile accounts
    imap_host: null,
    imap_port: null,
    imap_user: null,
    imap_password_secret_id: null,
    smtp_host: null,
    smtp_port: null,
    smtp_user: null,
    smtp_password_secret_id: null,
  };

  if (reuseRowId) {
    const { error } = await serviceClient
      .from("user_email_accounts")
      .update(accountRow)
      .eq("id", reuseRowId);

    if (error) {
      throw new Error(`Failed to update email account: ${error.message}`);
    }
  } else {
    const { error } = await serviceClient
      .from("user_email_accounts")
      .insert(accountRow);

    if (error) {
      throw new Error(`Failed to create email account: ${error.message}`);
    }
  }

  // If mailbox identity changed, delete user_contacts and trigger full sync
  if (identityChanged) {
    try {
      await serviceClient.from("user_contacts").delete().eq("user_id", userId);
      await triggerContactSync(userId, "full");
    } catch (err) {
      console.error("[email-accounts/notify] Failed to invalidate contacts:", err);
    }
  }

  console.log(
    `[email-accounts/notify] ${status} for user ${userId}: ${provider} account ${account_id} (${newEmail})`
  );

  return NextResponse.json({ ok: true });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Verifies an HMAC-signed correlation token and extracts the user ID.
 * Token format: userId:timestamp:hmacSignature
 * @param token - The correlation token from the Unipile callback
 * @param secret - The HMAC secret key
 * @returns The user ID if verification succeeds, null otherwise
 */
function verifyCorrelationToken(token: string, secret: string): string | null {
  const parts = token.split(":");
  if (parts.length < 3) {
    return null;
  }

  // The user ID may contain colons (UUIDs don't, but be safe)
  // Format is: userId:timestamp:signature
  const signature = parts[parts.length - 1];
  const timestamp = parts[parts.length - 2];
  const userId = parts.slice(0, parts.length - 2).join(":");

  if (!userId || !timestamp || !signature) {
    return null;
  }

  const payload = `${userId}:${timestamp}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Constant-time comparison
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");

  if (a.length !== b.length) {
    return null;
  }

  if (!timingSafeEqual(a, b)) {
    return null;
  }

  return userId;
}

/**
 * Triggers a contact sync via the voice pipeline.
 * @param userId - The user's ID
 * @param mode - "full" or "incremental"
 */
async function triggerContactSync(userId: string, mode: string): Promise<void> {
  try {
    console.log(`[email-accounts/notify] Triggering ${mode} contact sync for user ${userId}`);
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
    console.log(`[email-accounts/notify] Contact sync response: ${syncResponse.status}`);
  } catch (err) {
    console.error("[email-accounts/notify] Failed to trigger contact sync:", err);
  }
}
