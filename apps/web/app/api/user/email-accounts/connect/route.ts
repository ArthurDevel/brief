/**
 * API route for initiating a Unipile hosted auth connection.
 *
 * Generates an HMAC-signed correlation token and creates a Unipile hosted
 * auth link for Gmail or Outlook. Returns the link URL for the frontend
 * to redirect the user.
 *
 * Responsibilities:
 * - Authenticate user via Supabase session
 * - Accept provider ("gmail" | "outlook") from request body
 * - Generate HMAC-signed correlation token with user ID + timestamp
 * - Call Unipile createHostedAuthLink with the signed token as the name field
 * - Support reconnect flow if the user has an existing Unipile account
 * - Return the hosted auth URL
 */

import { cookies } from "next/headers";
import { createHmac } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { createHostedAuthLink } from "@/lib/unipile/client";
import { getActiveEmailAccount } from "@/lib/email-accounts";

// ============================================================================
// CONSTANTS
// ============================================================================

/** How long the hosted auth link remains valid (1 hour) */
const LINK_EXPIRY_MS = 60 * 60 * 1000;

/** Maps our provider names to Unipile provider constants */
const PROVIDER_MAP: Record<string, "GOOGLE" | "OUTLOOK"> = {
  gmail: "GOOGLE",
  outlook: "OUTLOOK",
};

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Creates a Unipile hosted auth link for connecting Gmail or Outlook.
 * @param request - The incoming request with { provider: "gmail" | "outlook" }
 * @returns JSON with { url: string } for the hosted auth link
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<{ url: string } | { error: string }>> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const provider = body.provider as string;

  if (!provider || !PROVIDER_MAP[provider]) {
    return NextResponse.json(
      { error: "Invalid provider. Must be 'gmail' or 'outlook'." },
      { status: 400 }
    );
  }

  const notifySecret = process.env.UNIPILE_NOTIFY_SECRET;
  if (!notifySecret) {
    throw new Error("UNIPILE_NOTIFY_SECRET environment variable is not set");
  }

  // Generate HMAC-signed correlation token
  const timestamp = Date.now().toString();
  const correlationToken = signCorrelationToken(user.id, timestamp, notifySecret);

  const notifyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/user/email-accounts/notify`;
  const expiresOn = new Date(Date.now() + LINK_EXPIRY_MS).toISOString();

  // Check if this is a reconnect (user has an existing Unipile account for this provider)
  const existingAccount = await getActiveEmailAccount(supabase, user.id);
  const isReconnect =
    existingAccount &&
    existingAccount.connectionType === "unipile" &&
    existingAccount.provider === provider;

  // If reconnecting, we need the unipile_account_id from the database
  let reconnectAccountId: string | undefined;
  if (isReconnect) {
    const { data: row } = await supabase
      .from("user_email_accounts")
      .select("unipile_account_id")
      .eq("id", existingAccount.id)
      .single();
    reconnectAccountId = row?.unipile_account_id ?? undefined;
  }

  console.log("[email-accounts/connect] Building hosted auth link:", {
    provider: PROVIDER_MAP[provider],
    type: isReconnect ? "reconnect" : "create",
    notifyUrl,
    expiresOn,
    reconnectAccountId,
  });

  const successRedirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`;

  const link = await createHostedAuthLink({
    type: isReconnect ? "reconnect" : "create",
    provider: PROVIDER_MAP[provider],
    expiresOn,
    notifyUrl,
    successRedirectUrl,
    name: correlationToken,
    reconnectAccountId,
  });

  console.log("[email-accounts/connect] Got hosted auth link:", link.url);

  return NextResponse.json({ url: link.url });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates an HMAC-signed correlation token containing user ID and timestamp.
 * Format: userId:timestamp:hmacSignature
 * @param userId - The Supabase user ID
 * @param timestamp - Unix timestamp as string
 * @param secret - The HMAC secret key
 * @returns The signed correlation token string
 */
function signCorrelationToken(
  userId: string,
  timestamp: string,
  secret: string
): string {
  const payload = `${userId}:${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `${payload}:${signature}`;
}
