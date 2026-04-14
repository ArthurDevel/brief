"use client";

/**
 * EmailStatusBanner.tsx
 *
 * Presentational banner that warns the user when their email is not configured,
 * the connection is broken, or a reconnection is required.
 * - Reads email status from EmailStatusContext
 * - Shows a red banner with actionable link to settings
 * - Hidden on the settings page and when status is loading or connected
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEmailStatus } from "@/contexts/EmailStatusContext";
import { getDashboardOnboardingState } from "@/lib/dashboard-onboarding";
import type { UserSettings } from "@/lib/types";

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
  reconnect_required: {
    text: "Your email account needs to be reconnected.",
    linkText: "Reconnect now",
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
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoadingOverviewSettings, setIsLoadingOverviewSettings] = useState(false);

  useEffect(() => {
    if (pathname !== "/dashboard" || !status || status === "connected") {
      setSettings(null);
      setIsLoadingOverviewSettings(false);
      return;
    }

    let cancelled = false;
    setIsLoadingOverviewSettings(true);

    void fetch("/api/user/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UserSettings | null) => {
        if (!cancelled) {
          setSettings(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingOverviewSettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, status]);

  if (!status || status === "connected") {
    return null;
  }

  if (pathname.startsWith("/dashboard/settings")) {
    return null;
  }

  if (pathname === "/dashboard") {
    if (isLoadingOverviewSettings) {
      return null;
    }

    if (settings && !getDashboardOnboardingState(settings, status).isComplete) {
      return null;
    }
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
