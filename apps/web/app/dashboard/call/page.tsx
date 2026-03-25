/**
 * Browser-based voice call page.
 *
 * Consumes the shared CallContext for all call state and actions.
 * The actual WebRTC session lifecycle is managed by CallProvider
 * (wrapped at the dashboard layout level).
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

  if (loading) {
    return <p className="text-gray-500">Loading...</p>;
  }

  if (loadError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {loadError}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="page-header">
        <h1>Browser Call</h1>
        <p>Place a direct call from your browser.</p>
      </div>

      <div className="page-content">
        {error && (
          <div className="mb-6 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Phone QR code section */}
        {!userPhone ? (
          // User has no phone number set
          <section className="settings-panel">
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Call from your phone</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
              Set your phone number in{" "}
              <a href="/dashboard/settings" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>Settings</a>{" "}
              to see the number you can call from your phone.
            </p>
          </section>
        ) : matchedCompanyPhone && qrDataUrl ? (
          // Match found -- show QR code
          <section className="settings-panel">
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Call from your phone</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>
              Scan this QR code to add the number to your contacts.
            </p>
            <div className="flex flex-col items-start gap-2">
              <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
              <span className="text-xs text-[var(--text-secondary)]">{matchedCompanyPhone.phoneNumber}</span>
            </div>
          </section>
        ) : (
          // No match -- show supported countries
          <section className="settings-panel">
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Call from your phone</h2>
            <p className="mb-2 text-sm font-medium text-red-600">
              Your country is currently not supported.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
              Phone calls are currently available in:{" "}
              {companyPhones.length > 0
                ? companyPhones.map((p) => p.label).join(", ")
                : "no countries configured yet"}
              .
            </p>
          </section>
        )}

      {/* Browser call component card */}
      <section className="settings-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Call from browser</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>
          Voice connection via the Pipecat pipeline (Deepgram STT + OpenRouter LLM + Deepgram TTS). Uses WebRTC.
        </p>

        <div className="settings-actions">
          <span className="text-[13px] font-medium text-[var(--text-secondary)] mr-4">{status}</span>

          {!callActive ? (
            <button onClick={startCall}>
              Start Call
            </button>
          ) : (
            <button onClick={endCall} style={{ background: "#d73a49" }}>
              End Call
            </button>
          )}
        </div>
      </section>
      
      </div>
    </div>
  );
}
