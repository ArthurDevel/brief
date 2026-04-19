"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type StartResponse = {
  phone: string;
  maskedPhone: string;
  verificationType: "magiclink" | "email";
};

export default function WhatsAppAuthShell({ currentPath }: { currentPath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phone, setPhone] = useState("");
  const [normalizedPhone, setNormalizedPhone] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [verificationType, setVerificationType] = useState<"magiclink" | "email">("magiclink");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState<"phone" | "code">("phone");

  useEffect(() => {
    const nextPhone = searchParams.get("phone");
    if (nextPhone) {
      setPhone(nextPhone);
    }
  }, [searchParams]);

  async function handleStart(): Promise<void> {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/whatsapp/auth/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone,
          redirectTo: currentPath,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to send WhatsApp code.");
      }

      const payload = data as StartResponse;
      setNormalizedPhone(payload.phone);
      setMaskedPhone(payload.maskedPhone);
      setVerificationType(payload.verificationType);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send WhatsApp code.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleVerify(): Promise<void> {
    if (!normalizedPhone) {
      setError("Enter your WhatsApp number first.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/whatsapp/auth/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: normalizedPhone,
          token: code,
          verificationType,
          redirectTo: currentPath,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to verify WhatsApp code.");
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify WhatsApp code.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <div className="settings-panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--text-secondary)]">
          WhatsApp Login
        </div>
        <h1 className="mt-2 text-[28px] font-semibold text-[var(--text-primary)]">
          Continue on this page
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          Enter the WhatsApp number that should receive your login code. We keep you on this
          <code> /whatsapp</code> page and sign you into the matching Supabase account.
        </p>

        <div className="mt-8 grid gap-4">
          <label className="grid gap-2 text-[13px] font-medium text-[var(--text-secondary)]">
            WhatsApp number
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 555 123 4567"
              disabled={isSubmitting || step === "code"}
              className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-3 text-[15px] text-[var(--text-primary)] outline-none"
            />
          </label>

          {step === "code" && (
            <label className="grid gap-2 text-[13px] font-medium text-[var(--text-secondary)]">
              Authentication code
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit code"
                disabled={isSubmitting}
                className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-3 text-[15px] tracking-[0.24em] text-[var(--text-primary)] outline-none"
              />
            </label>
          )}
        </div>

        {error && (
          <div className="mt-4 border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {step === "code" && maskedPhone && (
          <div className="mt-4 text-[13px] text-[var(--text-secondary)]">
            Code sent to <span className="font-medium text-[var(--text-primary)]">{maskedPhone}</span>.
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          {step === "phone" ? (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={isSubmitting || phone.trim().length === 0}
              className="bg-[var(--btn-primary-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--btn-primary-text)] disabled:opacity-50"
            >
              {isSubmitting ? "Sending..." : "Send code in WhatsApp"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={isSubmitting || code.length < 6}
                className="bg-[var(--btn-primary-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--btn-primary-text)] disabled:opacity-50"
              >
                {isSubmitting ? "Verifying..." : "Verify code"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep("phone");
                  setCode("");
                  setError(null);
                }}
                disabled={isSubmitting}
                className="border border-[var(--border-color)] px-4 py-2 text-[13px] font-semibold text-[var(--text-primary)]"
              >
                Change number
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
