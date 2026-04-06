/**
 * Context provider that fetches and caches the user's email configuration status.
 *
 * On mount, derives email status from the emailAccount summary on UserSettings.
 * If an account is configured and status is "connected", uses a 12-hour
 * localStorage cache (keyed by email address) to avoid re-testing on every
 * page load. Exposes the status and a refresh function to all dashboard children.
 *
 * Responsibilities:
 * - Fetch user settings and derive email status from emailAccount summary
 * - Cache connection test results in localStorage (12h TTL, keyed by email address)
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
 * Tests the email connection via the server-side endpoint.
 *
 * @returns The test connection response with imap and smtp results
 */
async function testConnection(): Promise<TestConnectionResponse> {
  const res = await fetch("/api/user/settings/test-connection", {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Connection test failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Determines the email status result from the settings emailAccount summary,
 * optionally running a connection test with localStorage caching.
 *
 * @param settings - The user's current settings
 * @returns The resolved email status result
 */
async function resolveEmailStatus(
  settings: UserSettings
): Promise<EmailStatusResult> {
  // Step 1: Check if email is configured at all
  if (!settings.emailAccount) {
    return { status: "not_configured" };
  }

  const account = settings.emailAccount;

  // Step 2: If the account has a non-connected status, return it directly
  if (account.status === "reconnect_required" || account.status === "error") {
    return { status: "error", message: account.lastError ?? undefined };
  }

  if (account.status === "pending") {
    return { status: "not_configured" };
  }

  // Step 3: Account reports "connected" -- verify with a cached connection test
  const cacheKey = account.emailAddress ?? account.id;

  const cached = getCachedEmailStatus(cacheKey);
  if (cached) {
    return cached;
  }

  // Step 4: Run the connection test and cache the result
  const testResult = await testConnection();

  const result: EmailStatusResult = testResult.imap.ok
    ? { status: "connected" }
    : { status: "error", message: testResult.imap.error };

  setCachedEmailStatus(cacheKey, result);
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
  const [cacheKey, setCacheKey] = useState<string | null>(null);

  /**
   * Runs the full email status check flow:
   * fetch settings -> derive from emailAccount -> check cache -> test connection.
   * On any network/server error, defaults to "connected" to avoid
   * showing a misleading banner.
   */
  const checkStatus = useCallback(async () => {
    setStatus(null);

    try {
      const settings = await fetchUserSettings();
      const key = settings.emailAccount?.emailAddress ?? settings.emailAccount?.id ?? null;
      setCacheKey(key);

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
    if (cacheKey) {
      clearEmailStatusCache(cacheKey);
    }
    checkStatus();
  }, [cacheKey, checkStatus]);

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
