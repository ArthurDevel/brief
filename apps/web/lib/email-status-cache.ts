/**
 * Email status cache utilities for localStorage.
 *
 * Caches the email connection status per user in localStorage so the app
 * does not need to re-test the IMAP connection on every page load.
 *
 * - Stores status scoped by userId
 * - Automatically invalidates entries older than 12 hours
 * - Provides get / set / clear helpers consumed by EmailStatusContext
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** Cache time-to-live: 12 hours in milliseconds */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Prefix used for the localStorage key */
const CACHE_KEY_PREFIX = "email_status_cache_";

// ============================================================================
// TYPES
// ============================================================================

export type EmailStatus = "not_configured" | "connected" | "error";

export interface EmailStatusResult {
  status: EmailStatus;
  message?: string;
}

interface CachedEmailStatus extends EmailStatusResult {
  checkedAt: number;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Retrieves the cached email status for a given user.
 * Returns null if no cache exists or the cache is older than 12 hours.
 *
 * @param userId - The ID of the user to look up
 * @returns The cached status object, or null if missing/stale
 */
export function getCachedEmailStatus(userId: string): EmailStatusResult | null {
  const key = CACHE_KEY_PREFIX + userId;
  const raw = localStorage.getItem(key);

  if (!raw) {
    return null;
  }

  const cached: CachedEmailStatus = JSON.parse(raw);

  // Check if cache has expired
  const age = Date.now() - cached.checkedAt;
  if (age > CACHE_TTL_MS) {
    localStorage.removeItem(key);
    return null;
  }

  return { status: cached.status, message: cached.message };
}

/**
 * Stores the email status for a given user in localStorage with a timestamp.
 *
 * @param userId - The ID of the user
 * @param status - The email status result to cache
 */
export function setCachedEmailStatus(
  userId: string,
  status: EmailStatusResult
): void {
  const key = CACHE_KEY_PREFIX + userId;

  const entry: CachedEmailStatus = {
    status: status.status,
    message: status.message,
    checkedAt: Date.now(),
  };

  localStorage.setItem(key, JSON.stringify(entry));
}

/**
 * Removes the cached email status for a given user.
 *
 * @param userId - The ID of the user whose cache should be cleared
 */
export function clearEmailStatusCache(userId: string): void {
  const key = CACHE_KEY_PREFIX + userId;
  localStorage.removeItem(key);
}
