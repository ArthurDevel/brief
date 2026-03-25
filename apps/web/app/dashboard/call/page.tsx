/**
 * Voice call page with two ways to start a conversation.
 *
 * Consumes the shared CallContext for all call state and actions.
 * The session lifecycle is managed by CallProvider (wrapped at the
 * dashboard layout level).
 *
 * Responsibilities:
 * - Render call UI (start/end buttons, status, errors)
 * - Delegate call actions to CallContext
 * - Display QR code for phone-based calling (matched to user's country)
 * - Show unsupported-country message when no matching company phone exists
 */

"use client";

import { useState, useEffect } from "react";
import { useCall } from "@/contexts/CallContext";
import { Smartphone, Monitor } from "lucide-react";
import * as QRCode from "qrcode";
import type { UserSettings, CompanyPhone, UserPhone } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const VCARD_CONTACT_NAME = "Brief.ai";

// ============================================================================
// API HELPERS
// ============================================================================

/**
 * Fetch the current user's settings.
 * @returns The user settings object
 */
async function fetchUserSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) throw new Error("Failed to load user settings");
  return res.json();
}

/**
 * Fetch company phone numbers for the current environment.
 * @returns Array of active company phones
 */
async function fetchCompanyPhones(): Promise<CompanyPhone[]> {
  const res = await fetch("/api/company-phones");
  if (!res.ok) throw new Error("Failed to load company phone numbers");
  return res.json();
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const { callActive, status, error, startCall, endCall } = useCall();

  // Data state
  const [userPhone, setUserPhone] = useState<UserPhone | null>(null);
  const [companyPhones, setCompanyPhones] = useState<CompanyPhone[]>([]);
  const [matchedCompanyPhone, setMatchedCompanyPhone] = useState<CompanyPhone | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch user settings and company phones on mount
  useEffect(() => {
    async function load() {
      try {
        const [settings, phones] = await Promise.all([
          fetchUserSettings(),
          fetchCompanyPhones(),
        ]);

        setUserPhone(settings.phone);
        setCompanyPhones(phones);

        // Match user's country to a company phone number
        if (settings.phone) {
          const match = phones.find((p) => p.countryCode === settings.phone!.countryCode);
          setMatchedCompanyPhone(match ?? null);

          // Generate QR code if a match was found
          if (match) {
            const vcard = [
              "BEGIN:VCARD",
              "VERSION:3.0",
              `FN:${VCARD_CONTACT_NAME}`,
              `N:;${VCARD_CONTACT_NAME};;;`,
              `TEL;TYPE=VOICE:${match.phoneNumber}`,
              "END:VCARD",
            ].join("\n");

            const dataUrl = await QRCode.toDataURL(vcard, { width: 200, margin: 2 });
            setQrDataUrl(dataUrl);
          }
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="page-header">
        <h1>Call</h1>
        <p>Start a voice conversation with your assistant.</p>
      </div>

      <div className="page-content">
        {loading ? (
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        ) : loadError ? (
          <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {loadError}
          </div>
        ) : (
          <>
        {error && (
          <div className="mb-6 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-6">

          {/* Phone card */}
          <section className="flex flex-col gap-4 p-6 md:p-8 border border-[var(--border-color)] bg-[var(--bg-surface)]">
            <div className="w-12 h-12 bg-blue-100/60 flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5 text-blue-600" strokeWidth={2.5} />
            </div>

            <div className="flex flex-col">
              <h3 className="text-lg font-bold text-[var(--text-primary)] mb-1">Call from your phone</h3>

              {!userPhone ? (
                <p className="text-[15px] text-[var(--text-secondary)] font-medium leading-relaxed">
                  Add your phone number in{" "}
                  <a href="/dashboard/settings" className="text-[var(--text-primary)] underline">Settings</a>{" "}
                  to get a number you can call directly.
                </p>
              ) : matchedCompanyPhone && qrDataUrl ? (
                <>
                  <p className="text-[15px] text-[var(--text-secondary)] font-medium leading-relaxed mb-5">
                    Scan this QR code to save the number to your contacts, then call it anytime.
                  </p>
                  <div className="flex flex-col items-start gap-2">
                    <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
                    <span className="text-[15px] font-medium text-[var(--text-secondary)]">{matchedCompanyPhone.phoneNumber}</span>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-red-600 mb-2">
                    Your country is not yet supported.
                  </p>
                  <p className="text-[15px] text-[var(--text-secondary)] font-medium leading-relaxed">
                    Phone calls are currently available in:{" "}
                    {companyPhones.length > 0
                      ? companyPhones.map((p) => p.label).join(", ")
                      : "no countries configured yet"}
                    .
                  </p>
                </>
              )}
            </div>
          </section>

          {/* Browser call card */}
          <section className="flex flex-col gap-4 p-6 md:p-8 border border-[var(--border-color)] bg-[var(--bg-surface)]">
            <div className="w-12 h-12 bg-purple-100/60 flex items-center justify-center shrink-0">
              <Monitor className="w-5 h-5 text-purple-600" strokeWidth={2.5} />
            </div>

            <div className="flex flex-col">
              <h3 className="text-lg font-bold text-[var(--text-primary)] mb-1">Call from your browser</h3>
              <p className="text-[15px] text-[var(--text-secondary)] font-medium leading-relaxed mb-5">
                Start a voice conversation directly from this page. No app or phone needed.
              </p>

              <div className="flex items-center gap-4">
                {!callActive ? (
                  <button
                    onClick={startCall}
                    className="flex items-center justify-center gap-2 bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] px-5 py-2.5 text-[13px] font-semibold border-none cursor-pointer hover:bg-[var(--btn-primary-hover)] transition"
                  >
                    Start Call
                  </button>
                ) : (
                  <button
                    onClick={endCall}
                    className="flex items-center justify-center gap-2 bg-red-600 text-white px-5 py-2.5 text-[13px] font-semibold border-none cursor-pointer hover:bg-red-700 transition"
                  >
                    End Call
                  </button>
                )}
                <span className="text-[13px] font-medium text-[var(--text-secondary)]">{status}</span>
              </div>
            </div>
          </section>

        </div>
        </>
        )}
      </div>
    </div>
  );
}
