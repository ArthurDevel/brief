"use client";

/**
 * ActiveCallBar.tsx
 *
 * A thin, fixed bar displayed at the top of the dashboard when a call is active.
 * - Reads call state from CallContext via the useCall() hook
 * - Shows the current call status and a link to navigate back to the call page
 * - Returns null when no call is active
 */

import React from "react";
import Link from "next/link";
import { useCall } from "@/contexts/CallContext";

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Renders a persistent top bar indicating an active call.
 * Only visible when a call is in progress. Clicking navigates to the call page.
 *
 * @returns The active call bar, or null if no call is active
 */
export default function ActiveCallBar(): React.ReactElement | null {
  const { callActive, status } = useCall();

  if (!callActive) {
    return null;
  }

  return (
    <Link
      href="/dashboard/call"
      className="flex items-center justify-center gap-2 px-4 py-1.5 bg-green-600 text-white text-sm font-medium no-underline cursor-pointer"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-white" />
      {status} -- Return to call
    </Link>
  );
}
