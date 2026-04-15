/**
 * API route for initiating a Unipile hosted auth connection.
 *
 * Generates an HMAC-signed correlation token and creates a Unipile hosted
 * auth link for Gmail or Outlook. Returns the link URL for the frontend
 * to redirect the user.
 *
 * Responsibilities:
 * - Authenticate user via Supabase session
 * - Accept provider ("gmail" | "outlook") plus optional connect intent
 * - Generate an HMAC-signed correlation token with user ID + timestamp
 * - Call Unipile createHostedAuthLink with the signed token as the name field
 * - Support explicit create vs reconnect flows
 * - Recover if a reconnect points at a deleted Unipile account
 * - Return the hosted auth URL
 */

import { cookies } from "next/headers";
import { createHmac } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { createHostedAuthLink } from "@/lib/unipile/client";
import { getActiveEmailAccount } from "@/lib/email-accounts";
import {
  getDashboardErrorMessage,
  type DashboardErrorCode,
} from "@/lib/errors/dashboardErrors";
import { mapDashboardErrorDetails } from "@/lib/errors/mapDashboardError";
import {
  normalizeConnectIntent,
  resolveSuccessRedirectUrl,
  resolveConnectMode,
  shouldRetryReconnectAsCreate,
} from "./logic";

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
 * @param request - The incoming request with { provider: "gmail" | "outlook", intent?: "create" | "reconnect" | "auto" }
 * @returns JSON with { url: string } for the hosted auth link
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<{ url: string } | { code: DashboardErrorCode; error: string }>> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerSupabaseClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return errorResponse("UNAUTHORIZED", 401);
    }

    const body = await request.json();
    const provider = body.provider as string;
    const intent = normalizeConnectIntent(body.intent);
    const returnTo = body.returnTo;

    if (!provider || !PROVIDER_MAP[provider]) {
      return errorResponse("EMAIL_CONNECT_FAILED", 400);
    }

    const providerKey = provider as "gmail" | "outlook";

    const notifySecret = process.env.UNIPILE_NOTIFY_SECRET;
    if (!notifySecret) {
      throw new Error("UNIPILE_NOTIFY_SECRET environment variable is not set");
    }

    const timestamp = Date.now().toString();
    const correlationToken = signCorrelationToken(user.id, timestamp, notifySecret);

    const notifyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/user/email-accounts/notify`;
    const expiresOn = new Date(Date.now() + LINK_EXPIRY_MS).toISOString();

    const existingAccount = await getActiveEmailAccount(supabase, user.id);

    let reconnectAccountId: string | undefined;
    if (
      existingAccount &&
      existingAccount.connectionType === "unipile" &&
      existingAccount.provider === providerKey
    ) {
      const { data: row } = await supabase
        .from("user_email_accounts")
        .select("unipile_account_id")
        .eq("id", existingAccount.id)
        .single();
      reconnectAccountId = row?.unipile_account_id ?? undefined;
    }

    const connectMode = resolveConnectMode({
      intent,
      provider: providerKey,
      existingAccount,
      reconnectAccountId,
    });

    console.log("[email-accounts/connect] Building hosted auth link:", {
      intent,
      provider: PROVIDER_MAP[provider],
      type: connectMode.type,
      notifyUrl,
      expiresOn,
      reconnectAccountId: connectMode.reconnectAccountId,
    });

    const successRedirectUrl = resolveSuccessRedirectUrl(
      returnTo,
      process.env.NEXT_PUBLIC_APP_URL!
    );

    const link = await createHostedAuthLinkWithFallback({
      type: connectMode.type,
      provider: PROVIDER_MAP[provider],
      expiresOn,
      notifyUrl,
      successRedirectUrl,
      name: correlationToken,
      reconnectAccountId: connectMode.reconnectAccountId,
      supabase,
      userId: user.id,
      existingAccountId: existingAccount?.id ?? null,
    });

    console.log("[email-accounts/connect] Got hosted auth link:", link.url);

    return NextResponse.json({ url: link.url });
  } catch (err) {
    console.error("[email-accounts/connect]", err);
    const { code, message } = mapDashboardErrorDetails(
      err,
      "settings-email",
      "EMAIL_CONNECT_FAILED"
    );
    return NextResponse.json({ code, error: message }, { status: 500 });
  }
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

function errorResponse(
  code: DashboardErrorCode,
  status: number
): NextResponse<{ code: DashboardErrorCode; error: string }> {
  return NextResponse.json(
    { code, error: getDashboardErrorMessage(code) },
    { status }
  );
}

async function createHostedAuthLinkWithFallback(input: {
  type: "create" | "reconnect";
  provider: "GOOGLE" | "OUTLOOK";
  expiresOn: string;
  notifyUrl: string;
  successRedirectUrl: string;
  name: string;
  reconnectAccountId?: string;
  supabase: ReturnType<typeof createServerSupabaseClient>;
  userId: string;
  existingAccountId: string | null;
}) {
  try {
    return await createHostedAuthLink({
      type: input.type,
      provider: input.provider,
      expiresOn: input.expiresOn,
      notifyUrl: input.notifyUrl,
      successRedirectUrl: input.successRedirectUrl,
      name: input.name,
      reconnectAccountId: input.reconnectAccountId,
    });
  } catch (err) {
    if (shouldRetryReconnectAsCreate(err, input.type) && input.existingAccountId) {
      console.warn(
        "[email-accounts/connect] Reconnect account missing on Unipile, retrying as create",
        { userId: input.userId, existingAccountId: input.existingAccountId }
      );

      await clearStaleUnipileAccount(input.supabase, input.userId, input.existingAccountId);

      return createHostedAuthLink({
        type: "create",
        provider: input.provider,
        expiresOn: input.expiresOn,
        notifyUrl: input.notifyUrl,
        successRedirectUrl: input.successRedirectUrl,
        name: input.name,
      });
    }

    throw err;
  }
}

async function clearStaleUnipileAccount(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
  accountId: string
): Promise<void> {
  const { error } = await supabase
    .from("user_email_accounts")
    .update({
      unipile_account_id: null,
      status: "reconnect_required",
      last_error: "The previous email connection no longer exists. Please reconnect.",
    })
    .eq("id", accountId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to clear stale Unipile account: ${error.message}`);
  }
}
