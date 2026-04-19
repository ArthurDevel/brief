import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/client";
import { checkRateLimit } from "@/lib/request-rate-limit";
import {
  getRateLimitKey,
  getWhatsAppAuthErrorMessage,
  normalizeWhatsAppPhone,
  sanitizeWhatsAppRedirectPath,
} from "@/lib/whatsapp-auth";

const VERIFY_LIMIT_MAX = 10;
const VERIFY_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const phone = normalizeWhatsAppPhone(typeof body?.phone === "string" ? body.phone : "");
  const token = typeof body?.token === "string" ? body.token.replace(/\D/g, "").slice(0, 6) : "";
  const redirectTo = sanitizeWhatsAppRedirectPath(body?.redirectTo);
  const verificationType =
    body?.verificationType === "magiclink" || body?.verificationType === "email"
      ? body.verificationType
      : "magiclink";

  if (!phone) {
    return NextResponse.json({ error: "Enter a valid WhatsApp number in international format." }, { status: 400 });
  }

  if (token.length < 6) {
    return NextResponse.json({ error: "Enter the 6-digit code from WhatsApp." }, { status: 400 });
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const rateLimit = checkRateLimit(
    "whatsapp-auth-verify",
    getRateLimitKey(ipAddress, phone),
    VERIFY_LIMIT_MAX,
    VERIFY_LIMIT_WINDOW_MS
  );

  if (!rateLimit.allowed) {
    console.warn("[whatsapp-auth/verify] rate limited", { phone, ipAddress });
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${rateLimit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  const serviceClient = createServiceRoleClient();
  const { data: linkedUser } = await serviceClient
    .from("user_settings")
    .select("user_id")
    .eq("whatsapp_phone", phone)
    .maybeSingle();

  if (!linkedUser?.user_id) {
    return NextResponse.json({ error: "No Supabase account is linked to that WhatsApp number yet." }, { status: 404 });
  }

  const { data: authUserResult, error: authUserError } = await serviceClient.auth.admin.getUserById(linkedUser.user_id);
  if (authUserError || !authUserResult.user?.email) {
    console.error("[whatsapp-auth/verify] linked user missing email", {
      phone,
      userId: linkedUser.user_id,
      error: authUserError?.message ?? null,
    });
    return NextResponse.json(
      { error: "That WhatsApp number is linked, but the account does not have an email login identity." },
      { status: 400 }
    );
  }

  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data, error } = await supabase.auth.verifyOtp({
    email: authUserResult.user.email,
    token,
    type: verificationType,
  });

  if (error) {
    console.error("[whatsapp-auth/verify] failed", { phone, ipAddress, error: error.message });
    return NextResponse.json({ error: getWhatsAppAuthErrorMessage(error.message) }, { status: 400 });
  }

  if (data.user?.id) {
    console.info("[whatsapp-auth/verify] login succeeded", {
      phone,
      ipAddress,
      userId: data.user.id,
      redirectTo,
    });
  }

  return NextResponse.json({
    ok: true,
    redirectTo,
  });
}
