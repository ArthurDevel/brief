/**
 * Dashboard call launcher page with phone-based call options and a browser-call entry point.
 *
 * Responsibilities:
 * - Display QR code for phone-based calling (matched to user's country)
 * - Show unsupported-country message when no matching company phone exists
 * - Trigger the outbound "Call me" flow
 * - Open the standalone browser-call page in a new tab
 */

"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { ChevronRight, Monitor, PhoneOutgoing, QrCode, Smartphone, UserPlus } from "lucide-react";
import * as QRCode from "qrcode";
import type { UserSettings, CompanyPhone, UserPhone } from "@/lib/types";
import { useEmailStatus } from "@/contexts/EmailStatusContext";
import { getDashboardErrorMessage } from "@/lib/errors/dashboardErrors";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";

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
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "CALL_SETTINGS_LOAD_FAILED",
      error: "Failed to load user settings",
    });
  }
  return res.json();
}

/**
 * Fetch company phone numbers for the current environment.
 * @returns Array of active company phones
 */
async function fetchCompanyPhones(): Promise<CompanyPhone[]> {
  const res = await fetch("/api/company-phones");
  if (!res.ok) {
    throw await buildDashboardErrorFromResponse(res, {
      code: "CALL_SETTINGS_LOAD_FAILED",
      error: "Failed to load company phone numbers",
    });
  }
  return res.json();
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const { status: emailStatus } = useEmailStatus();

  // Data state
  const [userPhone, setUserPhone] = useState<UserPhone | null>(null);
  const [companyPhones, setCompanyPhones] = useState<CompanyPhone[]>([]);
  const [matchedCompanyPhone, setMatchedCompanyPhone] = useState<CompanyPhone | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [phoneSectionOpen, setPhoneSectionOpen] = useState(false);
  const [browserSectionOpen, setBrowserSectionOpen] = useState(false);
  const [callMeStatus, setCallMeStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [callMeError, setCallMeError] = useState<string | null>(null);
  const [browserCallError, setBrowserCallError] = useState<string | null>(null);

  const hasConnectedInbox = emailStatus === "connected";
  const isInboxStatusLoading = emailStatus === null;
  const inboxRequiredMessage = emailStatus === "connected"
    ? ""
    : "We couldn't connect to your inbox. Go to Settings to connect it.";

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
        setLoadError(logAndMapDashboardError(err, "call", "CALL_SETTINGS_LOAD_FAILED"));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  /**
   * Downloads a vCard file so the user can save the company phone number as a contact.
   */
  const downloadVcard = useCallback(() => {
    if (!matchedCompanyPhone) return;

    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${VCARD_CONTACT_NAME}`,
      `N:;${VCARD_CONTACT_NAME};;;`,
      `TEL;TYPE=VOICE:${matchedCompanyPhone.phoneNumber}`,
      "END:VCARD",
    ].join("\n");

    const blob = new Blob([vcard], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${VCARD_CONTACT_NAME}.vcf`;
    a.click();
    URL.revokeObjectURL(url);
  }, [matchedCompanyPhone]);

  /**
   * Triggers an outbound call from the voice pipeline to the user's phone.
   */
  const triggerCallMe = useCallback(async () => {
    if (!hasConnectedInbox) {
      setCallMeStatus("error");
      setCallMeError(inboxRequiredMessage);
      return;
    }

    setCallMeStatus("loading");
    setCallMeError(null);

    try {
      const res = await fetch("/api/trigger-call", { method: "POST" });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        setCallMeStatus("success");
      } else {
        setCallMeStatus("error");
        setCallMeError(logAndMapDashboardError(data ?? { error: "Failed to initiate call." }, "call-trigger", "CALL_TRIGGER_FAILED"));
      }
    } catch (err) {
      setCallMeStatus("error");
      setCallMeError(logAndMapDashboardError(err, "call-trigger", "CALL_TRIGGER_FAILED"));
    }
  }, [hasConnectedInbox, inboxRequiredMessage]);

  /**
   * Opens the standalone browser-call screen in a new tab.
   * This must happen directly in the click handler so the browser treats it as a user-initiated tab open.
   */
  const openBrowserCall = useCallback(() => {
    if (!hasConnectedInbox) {
      setBrowserCallError(inboxRequiredMessage);
      return;
    }

    setBrowserCallError(null);
    window.open("/call", "_blank", "noopener,noreferrer");
  }, [hasConnectedInbox, inboxRequiredMessage]);

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
        {loading || isInboxStatusLoading ? (
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        ) : loadError ? (
          <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {loadError}
          </div>
        ) : !hasConnectedInbox ? (
          <section className="settings-panel">
            <div className="max-w-2xl">
              <h2 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 8px 0", letterSpacing: "-0.02em" }}>
                Connect your inbox first
              </h2>
              <p style={{ fontSize: 15, color: "var(--text-secondary)", margin: "0 0 18px 0", lineHeight: 1.5 }}>
                {inboxRequiredMessage} Once your inbox is connected, you’ll be able to call from your phone or start a browser call here.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  href="/dashboard/settings?tab=email"
                  style={{
                    background: "var(--btn-primary-bg)",
                    color: "var(--btn-primary-text)",
                    padding: "10px 16px",
                    fontSize: 13,
                    fontWeight: 500,
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  className="hover:opacity-90 transition-opacity"
                >
                  Connect inbox <span style={{ fontSize: 16 }}>&rsaquo;</span>
                </Link>
              </div>
            </div>
          </section>
        ) : (
          <>
        <div className="flex flex-col gap-6">

          {/* Phone card */}
          <section className="flex flex-col gap-4 border border-[var(--border-color)] bg-[var(--bg-surface)] p-6 md:p-8">
            <button
              type="button"
              onClick={() => setPhoneSectionOpen((prev) => !prev)}
              aria-expanded={phoneSectionOpen}
              className="flex w-full items-center justify-between gap-4 bg-transparent p-0 text-left"
            >
              <span className="flex min-w-0 items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center bg-blue-100/60">
                  <Smartphone className="h-5 w-5 text-blue-600" strokeWidth={2.5} />
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">Call from your phone</span>
              </span>
              <ChevronRight
                className={`h-5 w-5 shrink-0 text-[var(--text-secondary)] transition-transform ${
                  phoneSectionOpen ? "rotate-90" : ""
                }`}
                strokeWidth={2.5}
              />
            </button>

            {phoneSectionOpen && (
              <div className="flex flex-col">
                  {!userPhone ? (
                    <p className="text-[15px] text-[var(--text-secondary)] font-medium leading-relaxed">
                      Add your phone number in{" "}
                      <a href="/dashboard/settings" className="text-[var(--text-primary)] underline">Settings</a>{" "}
                      to get a number you can call directly.
                    </p>
                  ) : matchedCompanyPhone && qrDataUrl ? (
                    <>
                      {/* Desktop: always show QR */}
                      <div className="hidden md:block">
                        <p className="mb-5 text-[15px] font-medium leading-relaxed text-[var(--text-secondary)]">
                          Scan this QR code to save the number to your contacts, then call it anytime.
                        </p>
                        <div className="flex flex-col items-start gap-2">
                          <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
                          <span className="text-[15px] font-medium text-[var(--text-secondary)]">{matchedCompanyPhone.phoneNumber}</span>
                        </div>
                      </div>

                      {/* Mobile: buttons + toggleable QR */}
                      <div className="md:hidden">
                        <p className="mb-5 text-[15px] font-medium leading-relaxed text-[var(--text-secondary)]">
                          Save the number to your contacts, then call it anytime.
                        </p>
                        <div className="mb-4 flex max-w-[300px] flex-col gap-3">
                          <button
                            onClick={downloadVcard}
                            className="flex items-center gap-2 border-none bg-[var(--btn-primary-bg)] px-4 py-2.5 text-[13px] font-semibold text-[var(--btn-primary-text)] cursor-pointer transition hover:bg-[var(--btn-primary-hover)]"
                          >
                            <UserPlus className="h-4 w-4" />
                            Add to Contacts
                          </button>
                          <button
                            onClick={() => setShowQr((prev) => !prev)}
                            className="flex items-center gap-2 border border-[var(--border-color)] bg-[var(--bg-surface)] px-4 py-2.5 text-[13px] font-semibold text-[var(--text-primary)] cursor-pointer transition hover:bg-[var(--bg-hover)]"
                          >
                            <QrCode className="h-4 w-4" />
                            {showQr ? "Hide QR" : "Show QR"}
                          </button>
                        </div>
                        {showQr && (
                          <div className="flex flex-col items-start gap-2">
                            <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
                          </div>
                        )}
                        <span className="text-[15px] font-medium text-[var(--text-secondary)]">{matchedCompanyPhone.phoneNumber}</span>
                      </div>

                      {/* Call me button */}
                      <div className="mt-5 border-t border-[var(--border-color)] pt-5">
                        <p className="mb-3 text-[15px] font-medium leading-relaxed text-[var(--text-secondary)]">
                          Or have your assistant call you right now.
                        </p>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={triggerCallMe}
                            disabled={callMeStatus === "loading" || callMeStatus === "success"}
                            className="flex items-center gap-2 border-none bg-[var(--btn-primary-bg)] px-4 py-2.5 text-[13px] font-semibold text-[var(--btn-primary-text)] cursor-pointer transition hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <PhoneOutgoing className="h-4 w-4" />
                            {callMeStatus === "loading" ? "Calling..." : callMeStatus === "success" ? "Call initiated" : "Call me"}
                          </button>
                          {callMeStatus === "success" && (
                            <span className="text-[13px] font-medium text-green-600">Your phone should ring shortly.</span>
                          )}
                        </div>
                        {callMeStatus === "error" && callMeError && (
                          <p className="mt-2 text-[13px] font-medium text-red-600">{callMeError}</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mb-2 text-sm font-medium text-red-600">
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
            )}
          </section>

          {/* Browser call card */}
          <section className="flex flex-col gap-4 border border-[var(--border-color)] bg-[var(--bg-surface)] p-6 md:p-8">
            <button
              type="button"
              onClick={() => setBrowserSectionOpen((prev) => !prev)}
              aria-expanded={browserSectionOpen}
              className="flex w-full items-center justify-between gap-4 bg-transparent p-0 text-left"
            >
              <span className="flex min-w-0 items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center bg-purple-100/60">
                  <Monitor className="h-5 w-5 text-purple-600" strokeWidth={2.5} />
                </span>
                <span className="text-lg font-bold text-[var(--text-primary)]">Call from your browser</span>
              </span>
              <ChevronRight
                className={`h-5 w-5 shrink-0 text-[var(--text-secondary)] transition-transform ${
                  browserSectionOpen ? "rotate-90" : ""
                }`}
                strokeWidth={2.5}
              />
            </button>

            {browserSectionOpen && (
              <div className="flex flex-col">
                  <p className="mb-5 text-[15px] font-medium leading-relaxed text-[var(--text-secondary)]">
                    Start a browser call.
                  </p>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={openBrowserCall}
                      className="flex items-center justify-center gap-2 border-none bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-semibold text-[var(--btn-primary-text)] cursor-pointer transition hover:bg-[var(--btn-primary-hover)]"
                    >
                      Start browser call
                    </button>
                  </div>
                  {browserCallError && (
                    <p className="mt-2 text-[13px] font-medium text-red-600">{browserCallError}</p>
                  )}
              </div>
            )}
          </section>

        </div>
        </>
        )}
      </div>
    </div>
  );
}
