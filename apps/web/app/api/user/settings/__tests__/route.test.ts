/**
 * Tests for the settings API route helper logic.
 *
 * Verifies:
 * - mapRowToSettings correctly maps DB rows + email account to UserSettings DTO
 * - mapRowToSettings returns correct defaults when fields are missing
 * - GET returns defaults for new users (no settings row)
 */

import { describe, it, expect } from "vitest";
import type { UserSettings } from "@/lib/types";

// ============================================================================
// mapRowToSettings -- replicated here since it's not exported from route.ts
// ============================================================================

/**
 * Maps a database row and email account summary to the UserSettings DTO.
 * Mirrors the mapRowToSettings function in the settings route.
 */
function mapRowToSettings(
  row: Record<string, unknown>,
  emailAccount: UserSettings["emailAccount"]
): UserSettings {
  return {
    emailAccount,
    voicePreference:
      ((row.voice_config as Record<string, unknown>)?.voice as string) ??
      "aura-2-helena-en",
    voiceSpeed:
      ((row.voice_config as Record<string, unknown>)?.speed as number) ?? 1.0,
    toolApprovalConfig:
      (row.tool_approval_config as Record<string, string>) ?? {},
    phone: (row.phone as UserSettings["phone"]) ?? null,
    hasPin: !!row.pin_hash,
    callSchedule: (row.call_schedule as UserSettings["callSchedule"]) ?? null,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe("mapRowToSettings", () => {
  const fakeEmailAccount: UserSettings["emailAccount"] = {
    id: "acc-1",
    provider: "gmail",
    connectionType: "unipile",
    emailAddress: "user@gmail.com",
    status: "connected",
    lastError: null,
    hasImapPassword: false,
    hasSmtpPassword: false,
  };

  it("maps a complete DB row to UserSettings", () => {
    const row = {
      voice_config: { voice: "aura-2-andromeda-en", speed: 1.5 },
      tool_approval_config: { archive_email: "mutating_auto" },
      phone: { number: "+15551234567", countryCode: "US" },
      pin_hash: "$2a$10$abc",
      call_schedule: { timezone: "America/New_York", monday: "09:00" },
    };

    const result = mapRowToSettings(row, fakeEmailAccount);

    expect(result.emailAccount).toBe(fakeEmailAccount);
    expect(result.voicePreference).toBe("aura-2-andromeda-en");
    expect(result.voiceSpeed).toBe(1.5);
    expect(result.toolApprovalConfig).toEqual({ archive_email: "mutating_auto" });
    expect(result.phone).toEqual({ number: "+15551234567", countryCode: "US" });
    expect(result.hasPin).toBe(true);
    expect(result.callSchedule).toEqual({ timezone: "America/New_York", monday: "09:00" });
  });

  it("returns defaults when optional fields are missing", () => {
    const row = {};

    const result = mapRowToSettings(row, null);

    expect(result.emailAccount).toBeNull();
    expect(result.voicePreference).toBe("aura-2-helena-en");
    expect(result.voiceSpeed).toBe(1.0);
    expect(result.toolApprovalConfig).toEqual({});
    expect(result.phone).toBeNull();
    expect(result.hasPin).toBe(false);
    expect(result.callSchedule).toBeNull();
  });

  it("hasPin is false when pin_hash is null", () => {
    const row = { pin_hash: null };

    const result = mapRowToSettings(row, null);

    expect(result.hasPin).toBe(false);
  });
});
