/**
 * Unit tests for the email status cache utility.
 *
 * Verifies that:
 * - getCachedEmailStatus returns null when nothing is cached
 * - getCachedEmailStatus returns a fresh cached value
 * - getCachedEmailStatus invalidates and removes stale entries (> 12 hours)
 * - clearEmailStatusCache removes the stored entry
 * - Cache entries are scoped per user
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// CONSTANTS
// ============================================================================

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

// ============================================================================
// LOCALSTORAGE STUB
// ============================================================================

/**
 * Creates a simple in-memory localStorage implementation.
 * Node 25 ships a built-in localStorage that is incomplete (missing
 * getItem / setItem / removeItem / clear), which prevents jsdom from
 * properly overriding it. This stub sidesteps the issue entirely.
 */
function createLocalStorageStub(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem(key: string): string | null {
      return key in store ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      store = {};
    },
    get length(): number {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
  };
}

// Stub localStorage before importing the module under test, so that the
// module-level reference to localStorage resolves to our stub.
vi.stubGlobal("localStorage", createLocalStorageStub());

// Import AFTER stubbing so the module binds to the stubbed localStorage.
const {
  getCachedEmailStatus,
  setCachedEmailStatus,
  clearEmailStatusCache,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = await import("../email-status-cache");

// ============================================================================
// TESTS
// ============================================================================

describe("email-status-cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getCachedEmailStatus returns null when localStorage is empty", () => {
    const result = getCachedEmailStatus("user-1");
    expect(result).toBeNull();
  });

  it("getCachedEmailStatus returns cached value when fresh (< 12 hours)", () => {
    setCachedEmailStatus("user-1", {
      status: "connected",
      message: "OK",
    });

    const result = getCachedEmailStatus("user-1");
    expect(result).toEqual({ status: "connected", message: "OK" });
  });

  it("getCachedEmailStatus returns null and removes entry when stale (> 12 hours)", () => {
    // Write directly to localStorage with an old checkedAt timestamp
    const staleEntry = {
      status: "connected",
      message: "OK",
      checkedAt: Date.now() - TWELVE_HOURS_MS - 1,
    };
    localStorage.setItem(
      "email_status_cache_user-1",
      JSON.stringify(staleEntry)
    );

    const result = getCachedEmailStatus("user-1");
    expect(result).toBeNull();

    // Verify the stale entry was removed from localStorage
    expect(localStorage.getItem("email_status_cache_user-1")).toBeNull();
  });

  it("clearEmailStatusCache removes the stored entry", () => {
    setCachedEmailStatus("user-1", { status: "connected" });
    expect(getCachedEmailStatus("user-1")).not.toBeNull();

    clearEmailStatusCache("user-1");
    expect(getCachedEmailStatus("user-1")).toBeNull();
  });

  it("cache is scoped per user", () => {
    setCachedEmailStatus("user-a", { status: "connected" });

    const resultA = getCachedEmailStatus("user-a");
    const resultB = getCachedEmailStatus("user-b");

    expect(resultA).toEqual({ status: "connected", message: undefined });
    expect(resultB).toBeNull();
  });
});
