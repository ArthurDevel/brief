"use client";

/**
 * EmailStatusBanner.tsx
 *
 * Presentational banner that warns the user when their email is not configured
 * or the connection is broken.
 * - Reads email status from EmailStatusContext
 * - Shows a red banner with actionable link to settings
 * - Hidden on the settings page and when status is loading or connected
 */

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEmailStatus } from "@/contexts/EmailStatusContext";

const SETTINGS_EMAIL_URL = "/dashboard/settings?tab=email";

const STATUS_MESSAGES: Record<string, { text: string; linkText: string }> = {
  not_configured: {
    text: "No email account connected.",
    linkText: "Set up your email",
  },
  error: {
    text: "Could not connect to your email account.",
    linkText: "Check your settings",
  },
};

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Renders a red warning banner when the email connection is missing or broken.
 * Hidden when the status is loading, connected, or the user is on the settings page.
 *
 * @returns The email status banner, or null if not applicable
 */
export default function EmailStatusBanner(): React.ReactElement | null {
  const { status } = useEmailStatus();
  const pathname = usePathname();

  if (!status || status === "connected") {
    return null;
  }

  if (pathname.startsWith("/dashboard/settings")) {
    return null;
  }

  const message = STATUS_MESSAGES[status];
  if (!message) {
    return null;
  }

  return (
    <div
      className="flex items-center justify-between text-[13px] border-b"
      style={{
        padding: "10px 64px",
        background: "rgba(220, 38, 38, 0.1)",
        borderColor: "rgba(220, 38, 38, 0.15)",
        color: "#dc2626",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: "#dc2626",
            flexShrink: 0,
          }}
        />
        <span>{message.text}</span>
      </div>
      <Link
        href={SETTINGS_EMAIL_URL}
        className="font-medium underline"
        style={{ color: "#dc2626" }}
      >
        {message.linkText}
      </Link>
    </div>
  );
}
