/**
 * WhatsApp-scoped connectors overview page.
 *
 * Responsibilities:
 * - Stay inside the existing /whatsapp auth shell
 * - Load the signed-in user's saved Composio connections
 * - Show which connectors are connected and which need attention
 */

import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { listUserComposioConnections } from "@/lib/composio-connections";
import type { ComposioConnectionSummary } from "@/lib/types";
import { getWhatsAppProfile } from "@/lib/whatsapp-auth";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Loads the current connector state for the signed-in WhatsApp user.
 * @returns Connector overview page inside the WhatsApp layout
 */
export default async function WhatsAppConnectorsOverviewPage() {
  const cookieStore = await cookies();
  const supabase = createServerSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [profile, connections] = await Promise.all([
    getWhatsAppProfile(supabase, user),
    listUserComposioConnections(supabase, user.id),
  ]);

  const connectedConnections = connections.filter((connection) => connection.status === "connected");
  const nonConnectedConnections = connections.filter((connection) => connection.status !== "connected");

  return (
    <div className="grid gap-6">
      <section className="settings-panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          Connector Overview
        </div>
        <h1 className="mt-2 text-[28px] font-semibold">Your connected tools</h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          View the Composio connectors linked to your WhatsApp account.
        </p>

        <div className="mt-8 grid gap-4 text-[14px] md:grid-cols-3">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              WhatsApp number
            </div>
            <div className="mt-1">{profile.whatsappPhone ?? profile.authPhone ?? "Not linked yet"}</div>
          </div>

          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Connected
            </div>
            <div className="mt-1">{connectedConnections.length}</div>
          </div>

          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Saved connectors
            </div>
            <div className="mt-1">{connections.length}</div>
          </div>
        </div>
      </section>

      <section className="settings-panel">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          Connected
        </div>
        <h2 className="mt-2 text-[20px] font-semibold">Active connectors</h2>

        {connectedConnections.length === 0 ? (
          <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
            No connectors are connected yet.
          </p>
        ) : (
          <div className="mt-6 grid gap-4">
            {connectedConnections.map((connection) => (
              <ConnectorSummaryCard
                key={connection.toolkit}
                connection={connection}
              />
            ))}
          </div>
        )}
      </section>

      {nonConnectedConnections.length > 0 && (
        <section className="settings-panel">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Needs Attention
          </div>
          <h2 className="mt-2 text-[20px] font-semibold">Saved but not connected</h2>

          <div className="mt-6 grid gap-4">
            {nonConnectedConnections.map((connection) => (
              <ConnectorSummaryCard
                key={connection.toolkit}
                connection={connection}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Renders one connector summary row.
 * @param props - Connector data to display
 * @returns Connector summary card
 */
function ConnectorSummaryCard(props: {
  connection: ComposioConnectionSummary;
}) {
  return (
    <div className="border border-[var(--border-color)] px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[16px] font-semibold">{getToolkitLabel(props.connection.toolkit)}</div>
          <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
            Toolkit: {props.connection.toolkit}
          </div>
        </div>

        <div className="border border-[var(--border-color)] px-3 py-1 text-[12px] font-medium">
          {getConnectionStatusLabel(props.connection.status)}
        </div>
      </div>

      <div className="mt-4 grid gap-4 text-[14px] md:grid-cols-2">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Provider
          </div>
          <div className="mt-1">{props.connection.provider}</div>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Connected at
          </div>
          <div className="mt-1">{formatConnectedAt(props.connection.connectedAt)}</div>
        </div>

        <div className="md:col-span-2">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Connected account
          </div>
          <div className="mt-1 break-all">{props.connection.connectedAccountId ?? "Not saved"}</div>
        </div>

        {props.connection.lastError && (
          <div className="md:col-span-2">
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Last issue
            </div>
            <div className="mt-1">{props.connection.lastError}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns a readable label for the toolkit slug.
 * @param toolkit - Raw toolkit slug from the database
 * @returns Human-readable toolkit label
 */
function getToolkitLabel(toolkit: string): string {
  if (toolkit === "gmail") {
    return "Gmail";
  }

  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}

/**
 * Returns a readable label for a connector status.
 * @param status - Stored connector status
 * @returns Human-readable status label
 */
function getConnectionStatusLabel(
  status: ComposioConnectionSummary["status"]
): string {
  switch (status) {
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

/**
 * Formats the saved connection timestamp for display.
 * @param connectedAt - ISO timestamp, or null when never connected
 * @returns Human-readable date string
 */
function formatConnectedAt(connectedAt: string | null): string {
  if (!connectedAt) {
    return "Not available";
  }

  const parsedDate = new Date(connectedAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return connectedAt;
  }

  return parsedDate.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
