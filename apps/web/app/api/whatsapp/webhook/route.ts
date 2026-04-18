import { NextResponse, type NextRequest } from "next/server";
import { getDefaultAdminUserId } from "@/lib/admin";
import { createServiceRoleClient } from "@/lib/supabase/client";
import { getWhatsAppConfig, normalizePhoneNumber } from "@/lib/whatsapp";

type WebhookMessage = {
  from?: string;
  id?: string;
  type?: string;
  text?: {
    body?: string;
  };
};

type WebhookStatus = {
  id?: string;
  status?: string;
  errors?: Array<{ message?: string; title?: string }>;
};

async function resolveThreadUserId(contactPhoneNumber: string): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("user_id")
    .eq("contact_phone_number", contactPhoneNumber)
    .not("user_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.user_id ?? null;
}

export async function GET(request: NextRequest) {
  const config = getWhatsAppConfig();
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  if (
    mode === "subscribe"
    && token
    && challenge
    && config.webhookVerifyToken
    && token === config.webhookVerifyToken
  ) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null);

  if (!payload || payload.object !== "whatsapp_business_account") {
    return NextResponse.json({ received: true });
  }

  const config = getWhatsAppConfig();
  const supabase = createServiceRoleClient();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change?.value;
      const metadataPhoneNumberId = value?.metadata?.phone_number_id;

      if (config.phoneNumberId && metadataPhoneNumberId && metadataPhoneNumberId !== config.phoneNumberId) {
        continue;
      }

      for (const message of (value?.messages ?? []) as WebhookMessage[]) {
        const contactPhoneNumber = normalizePhoneNumber(message.from ?? "");
        if (!contactPhoneNumber || !message.id) continue;

        const userId = await resolveThreadUserId(contactPhoneNumber) ?? getDefaultAdminUserId();
        const text =
          message.type === "text"
            ? (message.text?.body ?? "")
            : `[Unsupported ${message.type ?? "message"} message]`;

        await supabase
          .from("whatsapp_messages")
          .upsert(
            {
              user_id: userId,
              contact_phone_number: contactPhoneNumber,
              direction: "inbound",
              text,
              meta_message_id: message.id,
              status: "received",
              raw_payload: message,
            },
            { onConflict: "meta_message_id" }
          );
      }

      for (const status of (value?.statuses ?? []) as WebhookStatus[]) {
        if (!status.id) continue;

        const nextStatus =
          status.status === "read"
            ? "read"
            : status.status === "delivered"
              ? "delivered"
              : status.status === "failed"
                ? "failed"
                : "sent";

        const errorMessage =
          status.errors?.map((error) => error.message || error.title).filter(Boolean).join("; ") || null;

        await supabase
          .from("whatsapp_messages")
          .update({
            status: nextStatus,
            error_message: errorMessage,
            raw_payload: status,
          })
          .eq("meta_message_id", status.id);
      }
    }
  }

  return NextResponse.json({ received: true });
}
