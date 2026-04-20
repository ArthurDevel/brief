"use client";

/**
 * Client-side WhatsApp Gmail connector card.
 *
 * Responsibilities:
 * - Render the current Gmail connection state
 * - Start the server-side Composio auth flow
 * - Show only safe, predefined error copy in the UI
 */

import { useState } from "react";
import type { ComposioConnectionSummary } from "@/lib/types";

// ============================================================================
// TYPES
// ============================================================================

interface StartRouteResponse {
  redirectUrl: string;
}

interface GmailConnectorCardProps {
  connection: ComposioConnectionSummary | null;
  notice: {
    kind: "success" | "error";
    message: string;
  } | null;
  whatsappPhone: string | null;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Renders the Gmail connector state and CTA inside the WhatsApp auth island.
 * @param props - Current connection state plus any server notice to show
 * @returns Interactive Gmail connector card
 */
export default function GmailConnectorCard(
  props: GmailConnectorCardProps
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleConnect(): Promise<void> {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/whatsapp/connectors/gmail/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "We could not start the Gmail connection. Please try again."
        );
      }

      const payload = data as StartRouteResponse;
      window.location.href = payload.redirectUrl;
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "We could not start the Gmail connection. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const buttonLabel =
    props.connection?.status === "connected"
      ? "Reconnect Gmail"
      : "Connect with Gmail";

  return (
    <div className="grid gap-6">
      <section className="settings-panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          Gmail Connector
        </div>
        <h1 className="mt-2 text-[28px] font-semibold">Connect Gmail from WhatsApp</h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          This page keeps the WhatsApp sign-in flow inline, then starts the Composio Gmail connection in-browser.
        </p>

        {props.notice && (
          <div
            className={`mt-6 border px-4 py-3 text-[13px] ${
              props.notice.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {props.notice.message}
          </div>
        )}

        {errorMessage && (
          <div className="mt-4 border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {errorMessage}
          </div>
        )}

        <div className="mt-8 grid gap-4 text-[14px]">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              WhatsApp number
            </div>
            <div className="mt-1">{props.whatsappPhone ?? "Not linked yet"}</div>
          </div>

          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Status
            </div>
            <div className="mt-1">{getConnectionStatusLabel(props.connection)}</div>
          </div>

          {props.connection?.connectedAccountId && (
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
                Connected account
              </div>
              <div className="mt-1 break-all">{props.connection.connectedAccountId}</div>
            </div>
          )}

          {props.connection?.lastError && (
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
                Last issue
              </div>
              <div className="mt-1">{props.connection.lastError}</div>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={isSubmitting}
            className="bg-[var(--btn-primary-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--btn-primary-text)] disabled:opacity-50"
          >
            {isSubmitting ? "Opening Gmail..." : buttonLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the human-readable label for the current connector state.
 * @param connection - Current Gmail connection summary
 * @returns Human-readable status label
 */
function getConnectionStatusLabel(
  connection: ComposioConnectionSummary | null
): string {
  if (!connection) {
    return "Not connected";
  }

  switch (connection.status) {
    case "connected":
      return "Connected";
    case "reconnect_required":
      return "Reconnect required";
    case "pending":
      return "Pending";
    case "error":
      return "Error";
    case "not_connected":
      return "Not connected";
  }
}
