/**
 * Tests for short-lived session review token helpers.
 *
 * These tests use small Supabase client mocks because the helper only needs
 * insert, lookup, and update behavior.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSessionReviewToken,
  hashSessionReviewToken,
  touchSessionReviewToken,
  validateSessionReviewToken,
} from "../session-review-tokens";

// ============================================================================
// TESTS
// ============================================================================

describe("session-review-tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hashes tokens deterministically without returning the raw token", () => {
    const token = "raw-token";

    const firstHash = hashSessionReviewToken(token);
    const secondHash = hashSessionReviewToken(token);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).not.toBe(token);
    expect(firstHash).toHaveLength(64);
  });

  it("creates a one-hour token and stores only the hash", async () => {
    const insertedRows: Record<string, unknown>[] = [];
    const supabase = makeInsertClient(insertedRows);

    const result = await createSessionReviewToken(supabase, {
      userId: "user-1",
      sessionId: "session-1",
    });

    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBe("2026-04-10T13:00:00.000Z");
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].user_id).toBe("user-1");
    expect(insertedRows[0].session_id).toBe("session-1");
    expect(insertedRows[0].expires_at).toBe("2026-04-10T13:00:00.000Z");
    expect(insertedRows[0].token_hash).toBe(hashSessionReviewToken(result.token));
    expect(insertedRows[0].token_hash).not.toBe(result.token);
  });

  it("validates an active token", async () => {
    const supabase = makeLookupClient({
      id: "token-1",
      user_id: "user-1",
      session_id: "session-1",
      expires_at: "2026-04-10T13:00:00.000Z",
      revoked_at: null,
    });

    const result = await validateSessionReviewToken(supabase, "raw-token");

    expect(result).toEqual({
      tokenId: "token-1",
      userId: "user-1",
      sessionId: "session-1",
      expiresAt: "2026-04-10T13:00:00.000Z",
    });
  });

  it("rejects expired and revoked tokens", async () => {
    const expiredClient = makeLookupClient({
      id: "token-1",
      user_id: "user-1",
      session_id: "session-1",
      expires_at: "2026-04-10T11:59:00.000Z",
      revoked_at: null,
    });
    const revokedClient = makeLookupClient({
      id: "token-2",
      user_id: "user-1",
      session_id: "session-1",
      expires_at: "2026-04-10T13:00:00.000Z",
      revoked_at: "2026-04-10T12:05:00.000Z",
    });

    await expect(validateSessionReviewToken(expiredClient, "expired")).resolves.toBeNull();
    await expect(validateSessionReviewToken(revokedClient, "revoked")).resolves.toBeNull();
  });

  it("updates the last used timestamp", async () => {
    const updatedRows: Record<string, unknown>[] = [];
    const supabase = makeUpdateClient(updatedRows);

    await touchSessionReviewToken(supabase, "token-1");

    expect(updatedRows).toEqual([
      {
        id: "token-1",
        values: { last_used_at: "2026-04-10T12:00:00.000Z" },
      },
    ]);
  });
});

// ============================================================================
// MOCK HELPERS
// ============================================================================

/**
 * Creates a minimal Supabase insert mock.
 * @param insertedRows - Captured insert rows
 * @returns Supabase client mock
 */
function makeInsertClient(insertedRows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: vi.fn(() => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return { error: null };
      }),
    })),
  } as unknown as SupabaseClient;
}

/**
 * Creates a minimal Supabase lookup mock.
 * @param row - Row returned from maybeSingle
 * @returns Supabase client mock
 */
function makeLookupClient(row: Record<string, unknown> | null): SupabaseClient {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: row, error: null })),
  };

  return {
    from: vi.fn(() => query),
  } as unknown as SupabaseClient;
}

/**
 * Creates a minimal Supabase update mock.
 * @param updatedRows - Captured update rows
 * @returns Supabase client mock
 */
function makeUpdateClient(updatedRows: Record<string, unknown>[]): SupabaseClient {
  let updateValues: Record<string, unknown> = {};

  const query = {
    update: vi.fn((values: Record<string, unknown>) => {
      updateValues = values;
      return query;
    }),
    eq: vi.fn(async (_column: string, id: string) => {
      updatedRows.push({ id, values: updateValues });
      return { error: null };
    }),
  };

  return {
    from: vi.fn(() => query),
  } as unknown as SupabaseClient;
}
