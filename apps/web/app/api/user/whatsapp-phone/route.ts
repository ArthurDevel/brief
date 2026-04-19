import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { normalizeWhatsAppPhone } from "@/lib/whatsapp-auth";

const UNIQUE_VIOLATION_CODE = "23505";

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const phone = normalizeWhatsAppPhone(typeof body?.phone === "string" ? body.phone : "");

  if (!phone) {
    return NextResponse.json(
      { error: "WhatsApp phone number must be in international format (e.g. +1234567890)." },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: user.id, whatsapp_phone: phone },
      { onConflict: "user_id" }
    );

  if (error) {
    if (error.code === UNIQUE_VIOLATION_CODE) {
      return NextResponse.json(
        { error: "This WhatsApp number is already linked to another account." },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, whatsappPhone: phone });
}
