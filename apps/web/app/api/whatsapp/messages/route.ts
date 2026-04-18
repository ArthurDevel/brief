import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { isAdminUserId } from "@/lib/admin";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { getWhatsAppConfig, getWhatsAppUiConfig, normalizePhoneNumber } from "@/lib/whatsapp";

type WhatsappMessageRow = {
  id: string;
  contact_phone_number: string;
  direction: "inbound" | "outbound";
  text: string;
  meta_message_id: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "received" | "failed";
  error_message: string | null;
  created_at: string;
};

async function getAuthenticatedAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (!isAdminUserId(user.id)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { supabase, user };
}

function mapMessage(row: WhatsappMessageRow) {
  return {
    id: row.id,
    contactPhoneNumber: row.contact_phone_number,
    direction: row.direction,
    text: row.text,
    metaMessageId: row.meta_message_id,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedAdmin();
  if ("error" in auth) return auth.error;

  const { supabase, user } = auth;
  const uiConfig = getWhatsAppUiConfig();
  const requestedPhoneNumber = normalizePhoneNumber(request.nextUrl.searchParams.get("phoneNumber") || "");
  const selectedRecipient = requestedPhoneNumber || uiConfig.recipients[0]?.value || null;

  let query = supabase
    .from("whatsapp_messages")
    .select("id, contact_phone_number, direction, text, meta_message_id, status, error_message, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (selectedRecipient) {
    query = query.eq("contact_phone_number", selectedRecipient);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    config: uiConfig,
    selectedRecipient,
    messages: (data ?? []).map(mapMessage),
  });
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedAdmin();
  if ("error" in auth) return auth.error;

  const { supabase, user } = auth;
  const config = getWhatsAppConfig();

  if (!config.accessToken || !config.phoneNumberId) {
    return NextResponse.json(
      { error: "Missing WhatsApp API configuration on the server." },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => null);
  const phoneNumber = normalizePhoneNumber(body?.phoneNumber ?? "");
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!phoneNumber) {
    return NextResponse.json({ error: "Recipient phone number is required." }, { status: 400 });
  }

  if (!text) {
    return NextResponse.json({ error: "Message text is required." }, { status: 400 });
  }

  const endpoint = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phoneNumber,
    type: "text",
    text: {
      body: text,
      preview_url: false,
    },
  };

  const graphResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const graphResult = await graphResponse.json().catch(() => ({}));

  if (!graphResponse.ok) {
    const { data: failedRow } = await supabase
      .from("whatsapp_messages")
      .insert({
        user_id: user.id,
        contact_phone_number: phoneNumber,
        direction: "outbound",
        text,
        status: "failed",
        error_message: graphResult?.error?.message ?? "WhatsApp send failed",
        raw_payload: graphResult,
      })
      .select("id, contact_phone_number, direction, text, meta_message_id, status, error_message, created_at")
      .single();

    return NextResponse.json(
      {
        error: graphResult?.error?.message ?? "WhatsApp send failed",
        message: failedRow ? mapMessage(failedRow as WhatsappMessageRow) : null,
      },
      { status: graphResponse.status }
    );
  }

  const metaMessageId =
    typeof graphResult?.messages?.[0]?.id === "string" ? graphResult.messages[0].id : null;

  const { data: insertedRow, error } = await supabase
    .from("whatsapp_messages")
    .insert({
      user_id: user.id,
      contact_phone_number: phoneNumber,
      direction: "outbound",
      text,
      meta_message_id: metaMessageId,
      status: "sent",
      raw_payload: graphResult,
    })
    .select("id, contact_phone_number, direction, text, meta_message_id, status, error_message, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    config: getWhatsAppUiConfig(),
    message: mapMessage(insertedRow as WhatsappMessageRow),
  });
}
