import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const DEFAULT_WHATSAPP_PATH = "/whatsapp";
const DEFAULT_WHATSAPP_AUTH_EMAIL_DOMAIN = "wa.OpenPokeButVoice.invalid";

export interface WhatsAppProfile {
  authPhone: string | null;
  whatsappPhone: string | null;
}

export function normalizeWhatsAppPhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed);
  if (parsed?.isValid()) {
    return parsed.number;
  }

  if (!trimmed.startsWith("+")) {
    return null;
  }

  const digitsOnly = trimmed.replace(/[^\d+]/g, "");
  return /^\+\d{8,15}$/.test(digitsOnly) ? digitsOnly : null;
}

export function maskWhatsAppPhone(phone: string | null): string {
  if (!phone) {
    return "your WhatsApp number";
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) {
    return phone;
  }

  return `${phone.slice(0, Math.max(2, phone.length - 4))}${"*".repeat(Math.min(4, digits.length - 2))}${digits.slice(-2)}`;
}

export function sanitizeWhatsAppRedirectPath(value: string | null | undefined): string {
  if (!value) {
    return DEFAULT_WHATSAPP_PATH;
  }

  if (!value.startsWith("/whatsapp")) {
    return DEFAULT_WHATSAPP_PATH;
  }

  return value;
}

export function getRateLimitKey(ipAddress: string | null, phone: string): string {
  return `${ipAddress ?? "unknown"}:${phone}`;
}

export function getWhatsAppAuthErrorMessage(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes("invalid") && lower.includes("otp")) {
    return "That code was invalid. Please try again.";
  }

  if (lower.includes("expired") || lower.includes("token has expired")) {
    return "That code expired. Request a new one.";
  }

  if (lower.includes("rate limit")) {
    return "Too many attempts. Please wait a minute and try again.";
  }

  if (lower.includes("email") && lower.includes("invalid")) {
    return "We could not prepare a WhatsApp login for that account.";
  }

  return "WhatsApp login failed. Please try again.";
}

export function getWhatsAppAuthEmailDomain(): string {
  return process.env.WHATSAPP_AUTH_EMAIL_DOMAIN?.trim() || DEFAULT_WHATSAPP_AUTH_EMAIL_DOMAIN;
}

export function buildWhatsAppSyntheticEmail(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `wa_${digits}@${getWhatsAppAuthEmailDomain()}`;
}

export async function getWhatsAppProfile(
  supabase: SupabaseClient,
  user: Pick<User, "id" | "phone">
): Promise<WhatsAppProfile> {
  const { data } = await supabase
    .from("user_settings")
    .select("whatsapp_phone")
    .eq("user_id", user.id)
    .maybeSingle();

  return {
    authPhone: user.phone ?? null,
    whatsappPhone: (data?.whatsapp_phone as string | null | undefined) ?? null,
  };
}

export async function saveWhatsAppPhoneForUser(
  supabase: SupabaseClient,
  userId: string,
  phone: string
): Promise<void> {
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      {
        user_id: userId,
        whatsapp_phone: phone,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    throw error;
  }
}
