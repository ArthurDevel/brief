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
 */

"use client";

import { useCall } from "@/contexts/CallContext";

// ============================================================================
// COMPONENT
// ============================================================================

export default function CallPage() {
  const { callActive, status, error, startCall, endCall } = useCall();

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
