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

const PHONE_NUMBER = "+16503999357";

const VCARD_CONTACT_NAME = "Brief.ai";

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  `FN:${VCARD_CONTACT_NAME}`,
  `N:;${VCARD_CONTACT_NAME};;;`,
  `TEL;TYPE=VOICE:${PHONE_NUMBER}`,
  "END:VCARD",
].join("\n");

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const { callActive, status, error, startCall, endCall } = useCall();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate vCard QR code on mount
  useEffect(() => {
    QRCode.toDataURL(VCARD, { width: 200, margin: 2 }).then(setQrDataUrl);
  }, []);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Browser Call</h1>

      {error && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* QR code to add the phone number as a contact */}
      {qrDataUrl && (
        <section className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Call from your phone</h2>
          <p className="mb-4 text-sm text-gray-500">
            Scan this QR code to add the number to your contacts.
          </p>
          <div className="flex flex-col items-start gap-2">
            <img src={qrDataUrl} alt="QR code to add phone contact" width={200} height={200} />
            <span className="text-xs text-gray-400">{PHONE_NUMBER}</span>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <p className="mb-4 text-sm text-gray-500">
          Voice connection via the Pipecat pipeline (Deepgram STT + OpenRouter LLM + Deepgram TTS). Uses WebRTC.
        </p>

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">{status}</span>

          {!callActive ? (
            <button
              onClick={startCall}
              className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Start Call
            </button>
          ) : (
            <button
              onClick={endCall}
              className="rounded-md bg-red-600 px-6 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              End Call
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
