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
 * - Display QR code for phone-based calling
 */

"use client";

import { useState, useEffect } from "react";
import { useCall } from "@/contexts/CallContext";
import * as QRCode from "qrcode";

// ============================================================================
// CONSTANTS
// ============================================================================

const PHONE_NUMBER = process.env.NEXT_PUBLIC_PHONE_NUMBER ?? "";

const VCARD_CONTACT_NAME = "Brief.ai";

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const { callActive, status, error, startCall, endCall } = useCall();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate vCard QR code on mount (only if phone number is configured)
  useEffect(() => {
    if (!PHONE_NUMBER) return;

    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${VCARD_CONTACT_NAME}`,
      `N:;${VCARD_CONTACT_NAME};;;`,
      `TEL;TYPE=VOICE:${PHONE_NUMBER}`,
      "END:VCARD",
    ].join("\n");

    QRCode.toDataURL(vcard, { width: 200, margin: 2 }).then(setQrDataUrl);
  }, []);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="flex-1 flex flex-col h-full">
      <div style={{ padding: "48px 64px 24px", flexShrink: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", margin: 0 }}>Browser Call</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, margin: 0 }}>Place a direct call from your browser.</p>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 64px 48px" }}>
        {error && (
          <div className="mb-6 border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* QR code to add the phone number as a contact */}
        {qrDataUrl && (
          <section className="settings-panel">
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Call from your phone</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 20px 0" }}>
              Scan this QR code to add the number to your contacts.
            </p>
          <div className="flex flex-col items-start gap-2">
            <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
            <span className="text-xs text-gray-400">{PHONE_NUMBER}</span>
          </div>
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
