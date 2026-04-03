/**
 * Context provider that fetches and caches the user's email configuration status.
 *
 * On mount, checks whether email is configured via GET /api/user/settings.
 * If configured, uses a 12-hour localStorage cache to avoid re-testing the
 * IMAP connection on every page load. Exposes the status and a refresh
 * function to all dashboard children.
 *
 * Responsibilities:
 * - Fetch user settings and determine email configuration state
 * - Cache IMAP connection test results in localStorage (12h TTL)
 * - Expose status + refresh to consuming components via context
 */

"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import {
  getCachedEmailStatus,
  setCachedEmailStatus,
  clearEmailStatusCache,
  type EmailStatus,
  type EmailStatusResult,
} from "@/lib/email-status-cache";
import type { UserSettings } from "@/lib/types";

// ============================================================================
// TYPES
// ============================================================================

/** Response shape from POST /api/user/settings/test-connection */
interface TestConnectionResponse {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

/** Values exposed by the EmailStatusContext to consuming components. */
interface EmailStatusContextValue {
  /** Current email status, or null while loading */
  status: EmailStatus | null;
  /** Clears the cache and re-runs the full status check */
  refresh: () => void;
}

// ============================================================================
// CONTEXT
// ============================================================================

const EmailStatusContext = createContext<EmailStatusContextValue | null>(null);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Fetches user settings from the API.
 *
 * @returns The user settings object
 */
async function fetchUserSettings(): Promise<UserSettings> {
  const res = await fetch("/api/user/settings");
  if (!res.ok) {
    throw new Error(`Failed to fetch settings: ${res.status}`);
  }
  return res.json();
}

/**
 * Tests the IMAP connection via the server-side endpoint.
 *
 * @returns The test connection response with imap and smtp results
 */
async function testImapConnection(): Promise<TestConnectionResponse> {
  const res = await fetch("/api/user/settings/test-connection", {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Connection test failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Determines the email status result by checking settings and optionally
 * testing the IMAP connection (with localStorage caching).
 *
 * @param settings - The user's current settings
 * @returns The resolved email status result
 */
async function resolveEmailStatus(
  settings: UserSettings
): Promise<EmailStatusResult> {
  // Step 1: Check if email is configured at all
  if (!settings.imapHost || !settings.hasImapPassword) {
    return { status: "not_configured" };
  }

  // Use imapUser as a stable identifier for caching
  const userId = settings.imapUser;

  // Step 2: Check localStorage cache
  const cached = getCachedEmailStatus(userId);
  if (cached) {
    return cached;
  }

  // Step 3: Test connection and cache the result
  const testResult = await testImapConnection();

  const result: EmailStatusResult = testResult.imap.ok
    ? { status: "connected" }
    : { status: "error", message: testResult.imap.error };

  setCachedEmailStatus(userId, result);
  return result;
}

// ============================================================================
// PROVIDER
// ============================================================================

/**
 * Context provider that manages email configuration status.
 *
 * Wraps the dashboard layout so all children can read the current email
 * status and trigger a refresh after settings changes.
 *
 * @param children - React children to wrap
 * @returns The provider JSX element
 */
export function EmailStatusProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [imapUser, setImapUser] = useState<string | null>(null);

  /**
   * Runs the full email status check flow:
   * fetch settings -> check config -> check cache -> test connection.
   * On any network/server error, defaults to "connected" to avoid
   * showing a misleading banner.
   */
  const checkStatus = useCallback(async () => {
    setStatus(null);

    try {
      const settings = await fetchUserSettings();
      setImapUser(settings.imapUser || null);

      const result = await resolveEmailStatus(settings);
      setStatus(result.status);
    } catch {
      // Fail silently -- don't show a misleading banner on network errors
      setStatus("connected");
    }
  }, []);

  /**
   * Clears the localStorage cache for the current user and re-runs
   * the full status check. Intended for use after saving settings.
   */
  const refresh = useCallback(() => {
    if (imapUser) {
      clearEmailStatusCache(imapUser);
    }
    checkStatus();
  }, [imapUser, checkStatus]);

  // Run the check on mount
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const value: EmailStatusContextValue = { status, refresh };

  return (
    <EmailStatusContext.Provider value={value}>
      {children}
    </EmailStatusContext.Provider>
  );
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to consume the email status context.
 * Must be used within an EmailStatusProvider.
 *
 * @returns Object with status (EmailStatus | null) and refresh function
 */
export function useEmailStatus(): EmailStatusContextValue {
  const context = useContext(EmailStatusContext);
  if (!context) {
    throw new Error(
      "useEmailStatus must be used within an EmailStatusProvider"
    );
  }
  return context;
}
