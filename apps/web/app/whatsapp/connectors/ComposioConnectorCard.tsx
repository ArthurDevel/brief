"use client";

/**
 * Client-side card for one WhatsApp Composio connector.
 *
 * Responsibilities:
 * - Render the current connector state
 * - Start the server-side Composio auth flow
 * - Show only safe, predefined error copy in the UI
 */

import { useState } from "react";
import type { ComposioConnectionSummary } from "@/lib/types";
import type { ConnectorNotice } from "./connectorLogic";
import {
  getConnectorStartErrorMessage,
} from "./connectorLogic";
import type { WhatsAppConnectorDefinition } from "./connectorDefinitions";

// ============================================================================
// TYPES
// ============================================================================

interface StartRouteSuccessResponse {
  redirectUrl: string;
}

interface StartRouteErrorResponse {
  code?: string;
}

interface ComposioConnectorCardProps {
  connection: ComposioConnectionSummary | null;
  definition: WhatsAppConnectorDefinition;
  notice: ConnectorNotice | null;
  whatsappPhone: string | null;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Renders one connector state and CTA inside the WhatsApp auth shell.
 * @param props - Current connection state plus shared connector copy
 * @returns Interactive connector card
 */
export default function ComposioConnectorCard(
  props: ComposioConnectorCardProps
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleConnect(): Promise<void> {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/whatsapp/connectors/${props.definition.routeSegment}/start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const payload = data as StartRouteErrorResponse | null;
        throw new Error(
          getConnectorStartErrorMessage(props.definition, payload?.code)
        );
      }

      const payload = data as StartRouteSuccessResponse;
      window.location.assign(payload.redirectUrl);
    } catch (error) {
      console.error("[whatsapp-connector/card] failed to start connector", {
        toolkit: props.definition.toolkit,
        error: error instanceof Error ? error.message : String(error),
      });

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const buttonLabel =
    props.connection?.status === "connected"
      ? `Reconnect ${props.definition.label}`
      : `Connect ${props.definition.label}`;

  return (
    <div className="grid gap-6">
      <section className="settings-panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {props.definition.label} Connector
        </div>
        <h1 className="mt-2 text-[28px] font-semibold">
          Connect {props.definition.label} from WhatsApp
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          {props.definition.pageDescription}
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
            {isSubmitting ? props.definition.loadingLabel : buttonLabel}
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
 * @param connection - Current connector connection summary
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
