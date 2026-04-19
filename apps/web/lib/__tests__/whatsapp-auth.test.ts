import { describe, expect, it } from "vitest";
import {
  buildWhatsAppSyntheticEmail,
  maskWhatsAppPhone,
  normalizeWhatsAppPhone,
  sanitizeWhatsAppRedirectPath,
} from "@/lib/whatsapp-auth";

describe("normalizeWhatsAppPhone", () => {
  it("normalizes valid numbers to E.164", () => {
    expect(normalizeWhatsAppPhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("rejects numbers without an international prefix", () => {
    expect(normalizeWhatsAppPhone("5551234567")).toBeNull();
  });
});

describe("sanitizeWhatsAppRedirectPath", () => {
  it("keeps valid whatsapp paths", () => {
    expect(sanitizeWhatsAppRedirectPath("/whatsapp/account?phone=1")).toBe("/whatsapp/account?phone=1");
  });

  it("falls back for non-whatsapp paths", () => {
    expect(sanitizeWhatsAppRedirectPath("/dashboard")).toBe("/whatsapp");
  });
});

describe("maskWhatsAppPhone", () => {
  it("masks the trailing digits", () => {
    expect(maskWhatsAppPhone("+15551234567")).toContain("**");
  });
});

describe("buildWhatsAppSyntheticEmail", () => {
  it("builds a deterministic internal email from the phone number", () => {
    expect(buildWhatsAppSyntheticEmail("+1 555 123 4567")).toBe("wa_15551234567@wa.brewdock.invalid");
  });
});
