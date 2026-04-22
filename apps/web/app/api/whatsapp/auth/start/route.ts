import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { checkRateLimit } from "@/lib/request-rate-limit";
import {
  buildWhatsAppSyntheticEmail,
  getRateLimitKey,
  maskWhatsAppPhone,
  normalizeWhatsAppPhone,
  saveWhatsAppPhoneForUser,
  sanitizeWhatsAppRedirectPath,
} from "@/lib/whatsapp-auth";
import { getWhatsAppMessagingConfig, sendWhatsAppAuthTemplate } from "@/lib/whatsapp-messaging";

const START_LIMIT_MAX = 5;
const START_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const VERIFICATION_TYPE = "magiclink";

/**
 * Extracts WhatsApp Graph API message IDs from a send response.
 * @param responseBody - Parsed Graph API response payload
 * @returns Array of message IDs when present
 */
function getGraphMessageIds(responseBody: unknown): string[] {
  if (!responseBody || typeof responseBody !== "object" || !("messages" in responseBody)) {
    return [];
  }

  const messages = (responseBody as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || !("id" in message)) {
        return null;
      }

      return typeof message.id === "string" ? message.id : null;
    })
    .filter((messageId): messageId is string => messageId !== null);
}

async function resolveOrCreateWhatsAppUser(
  supabase: ReturnType<typeof createServiceRoleClient>,
  phone: string
): Promise<{ userId: string; email: string; created: boolean }> {
  const { data: linkedUser } = await supabase
    .from("user_settings")
    .select("user_id")
    .eq("whatsapp_phone", phone)
    .maybeSingle();

  if (linkedUser?.user_id) {
    const { data: authUserResult, error: authUserError } = await supabase.auth.admin.getUserById(linkedUser.user_id);
    if (authUserError) {
      throw authUserError;
    }

    const existingEmail = authUserResult.user?.email;
    if (existingEmail) {
      return {
        userId: linkedUser.user_id,
        email: existingEmail,
        created: false,
      };
    }

    const syntheticEmail = buildWhatsAppSyntheticEmail(phone);
    const { data: updatedUserResult, error: updateError } = await supabase.auth.admin.updateUserById(
      linkedUser.user_id,
      {
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          ...(authUserResult.user?.user_metadata ?? {}),
          whatsapp_phone: phone,
          whatsapp_auth: true,
          whatsapp_auth_email: syntheticEmail,
        },
      }
    );

    if (updateError || !updatedUserResult.user?.email) {
      throw updateError ?? new Error("Failed to attach an internal email to the WhatsApp account.");
    }

    return {
      userId: linkedUser.user_id,
      email: updatedUserResult.user.email,
      created: false,
    };
  }

  const syntheticEmail = buildWhatsAppSyntheticEmail(phone);
  const { data: createdUserResult, error: createError } = await supabase.auth.admin.createUser({
    email: syntheticEmail,
    email_confirm: true,
    user_metadata: {
      whatsapp_phone: phone,
      whatsapp_auth: true,
      whatsapp_auth_email: syntheticEmail,
    },
    app_metadata: {
      signup_source: "whatsapp",
    },
  });

  if (createError || !createdUserResult.user?.id || !createdUserResult.user.email) {
    throw createError ?? new Error("Failed to create the WhatsApp Supabase user.");
  }

  await saveWhatsAppPhoneForUser(supabase, createdUserResult.user.id, phone);

  return {
    userId: createdUserResult.user.id,
    email: createdUserResult.user.email,
    created: true,
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const phone = normalizeWhatsAppPhone(typeof body?.phone === "string" ? body.phone : "");
  const redirectTo = sanitizeWhatsAppRedirectPath(body?.redirectTo);

  if (!phone) {
    return NextResponse.json({ error: "Enter a valid WhatsApp number in international format." }, { status: 400 });
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const rateLimit = checkRateLimit(
    "whatsapp-auth-start",
    getRateLimitKey(ipAddress, phone),
    START_LIMIT_MAX,
    START_LIMIT_WINDOW_MS
  );

  if (!rateLimit.allowed) {
    console.warn("[whatsapp-auth/start] rate limited", { phone, ipAddress });
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rateLimit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  const supabase = createServiceRoleClient();
  let linkedIdentity: { userId: string; email: string; created: boolean };
  try {
    linkedIdentity = await resolveOrCreateWhatsAppUser(supabase, phone);
  } catch (identityError) {
    console.error("[whatsapp-auth/start] failed to resolve identity", {
      phone,
      ipAddress,
      error: identityError instanceof Error ? identityError.message : String(identityError),
    });
    return NextResponse.json({ error: "Failed to prepare the WhatsApp login account." }, { status: 500 });
  }

  const { data, error } = await supabase.auth.admin.generateLink({
    type: VERIFICATION_TYPE,
    email: linkedIdentity.email,
    options: {
      redirectTo,
    },
  });

  if (error || !data?.properties?.email_otp) {
    console.error("[whatsapp-auth/start] generateLink failed", {
      phone,
      ipAddress,
      userId: linkedIdentity.userId,
      error: error?.message ?? null,
    });
    return NextResponse.json({ error: "Failed to generate a login code." }, { status: 400 });
  }

  const config = getWhatsAppMessagingConfig();
  console.info("[whatsapp-auth/start] sending otp", {
    phone,
    ipAddress,
    userId: linkedIdentity.userId,
    senderPhoneNumberId: config.phoneNumberId,
    templateName: "otp_code",
  });

  try {
    const sendResult = await sendWhatsAppAuthTemplate(config, phone, data.properties.email_otp);

    console.info("[whatsapp-auth/start] whatsapp send accepted", {
      phone,
      ipAddress,
      userId: linkedIdentity.userId,
      senderPhoneNumberId: sendResult.phoneNumberId,
      recipient: sendResult.recipient,
      templateName: sendResult.templateName,
      messageIds: getGraphMessageIds(sendResult.responseBody),
      graphResponse: sendResult.responseBody,
    });
  } catch (sendError) {
    console.error("[whatsapp-auth/start] whatsapp send failed", {
      phone,
      ipAddress,
      userId: linkedIdentity.userId,
      senderPhoneNumberId: config.phoneNumberId,
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
    return NextResponse.json({ error: "We could not send the WhatsApp code." }, { status: 502 });
  }

  console.info("[whatsapp-auth/start] otp requested", {
    phone,
    ipAddress,
    userId: linkedIdentity.userId,
    createdUser: linkedIdentity.created,
    redirectTo,
    verificationType: data.properties.verification_type,
  });

  return NextResponse.json({
    ok: true,
    phone,
    maskedPhone: maskWhatsAppPhone(phone),
    verificationType: data.properties.verification_type,
  });
}
